import type { Provider } from '@ethersproject/providers';
import { BigNumber, BigNumberish, Signer, utils } from 'ethers';
import { gql, GraphQLClient } from 'graphql-request';
import { LOTTERY_7_35_CONFIG, ZERO } from '../constants';
import { ERC20, ERC20__factory, Lottery as LotteryContract, Lottery__factory } from '../typechain';
import { PromiseOrValue } from '../typechain/common';
import {
  convertLotteryTicketToNumbers,
  convertNumbersToLotteryTicket,
  generateRandomTickets,
  TicketCombination,
  TicketCombinations,
} from '../utils';
import { LotteryConfig } from './config';

type LotteryTierWinnersCount = {
  [tier: number]: number;
};

type LotteryTierPrizes = {
  [tier: number]: BigNumber;
};

export interface LotteryDrawInfo {
  drawId: number;
  scheduledDate: Date;
  winningCombination: TicketCombination;
  numberOfWinnersPerTier: LotteryTierWinnersCount;
  prizesPerTier: LotteryTierPrizes;
}

/**
 * The status of a lottery ticket.
 */
export type LotteryTicketStatus =
  /**
   * The ticket is active (the ticket's draw is not finalized).
   */
  | 'active'
  /**
   * The ticket is not winning and thus cannot be claimed (the draw is finalized).
   */
  | 'unclaimable'
  /**
   * The ticket is winning, but has not been claimed (the draw is finalized).
   */
  | 'unclaimed'
  /**
   * The ticket has been claimed.
   */
  | 'claimed'
  /**
   * The ticket has expired (the ticket's draw is finalized and the ticket has not been claimed).
   */
  | 'expired';

export class LotteryTicketHistory {
  private static DRAWS_PER_YEAR = 52;

  /**
   * The ID of the ticket.
   */
  public readonly ticketId: BigNumber;

  /**
   * The ID of the draw the ticket was purchased for.
   */
  public readonly draw: number;

  /**
   * The numbers on the ticket.
   */
  public readonly combination: TicketCombination | null;

  /**
   * The matched numbers for the ticket. This is only available if the draw has already been finalized.
   */
  public readonly matchedNumbers: TicketCombination | null;

  private readonly isClaimed: boolean;
  private readonly calculateReward: (winTier: number) => Promise<BigNumber>;
  private readonly lotteryMinWinningTier: number;

  /**
   * Creates a lottery ticket history instance.
   * @param ticketId The ID of the ticket.
   * @param draw The ID of the draw the ticket was purchased for.
   * @param combination The numbers on the ticket.
   * @param isClaimed Whether the ticket has been claimed.
   * @param calculateReward A function that calculates the reward for a given win tier.
   * @param drawWinningCombination The winning combination for the draw.
   * @param lotteryMinWinningTier The minimum win tier for which the reward is paid in the lottery.
   */
  constructor(
    ticketId: BigNumber,
    draw: number,
    combination: TicketCombination | null,
    isClaimed: boolean,
    calculateReward: (winTier: number) => Promise<BigNumber>,
    drawWinningCombination: TicketCombination | null,
    lotteryMinWinningTier: number,
  ) {
    this.ticketId = ticketId;
    this.draw = draw;
    this.combination = combination;
    this.matchedNumbers =
      drawWinningCombination && this.combination
        ? new Set([...this.combination].filter(number => drawWinningCombination?.has(number)))
        : null;
    this.isClaimed = isClaimed;
    this.calculateReward = calculateReward;
    this.lotteryMinWinningTier = lotteryMinWinningTier;
  }

  /**
   * The win tier for the ticket. This is only available if the draw has already been finalized.
   */
  public get winTier(): number | null {
    return this.matchedNumbers?.size ?? null;
  }

  /**
   * Whether the ticket is a jackpot winning ticket. This is only available if the draw has already been finalized.
   */
  public get isJackpotWinningTicket(): boolean {
    return this.winTier !== null && this.combination !== null && this.winTier === this.combination.size;
  }

  /**
   * The reward for the ticket. This is only available if the draw has already been finalized.
   */
  public get reward(): Promise<BigNumber> {
    return this.winTier ? this.calculateReward(this.winTier) : Promise.resolve(ZERO);
  }

  /**
   * Returns whether the ticket has been claimed.
   */
  public getStatus(currentDraw: number): LotteryTicketStatus {
    if (this.draw >= currentDraw || this.winTier === null) {
      return 'active';
    }

    if (this.isClaimed) {
      return 'claimed';
    }

    if (this.winTier < this.lotteryMinWinningTier) {
      return 'unclaimable';
    }

    if (this.draw + LotteryTicketHistory.DRAWS_PER_YEAR < currentDraw) {
      return 'expired';
    }

    return 'unclaimed';
  }
}

interface PlayerResponse {
  id: string;
  drawStats: {
    numberOfTickets: string;
    numberOfWinningTickets: string;
    numberOfClaimedTickets: string;
    drawId: string;
  }[];
}

export interface DrawStats {
  numberOfTickets: number;
  numberOfWinningTickets: number;
  numberOfClaimedTickets: number;
  drawId: number;
}

export class Player {
  public walletAddress: string;
  public drawStats: DrawStats[];

  constructor(walletAddress: string, drawStats: DrawStats[]) {
    this.walletAddress = walletAddress;
    this.drawStats = drawStats;
  }
}

/**
 * Represents a lottery ticket for a draw.
 * @property drawId The ID of the draw.
 * @property ticketNumbers The numbers on the ticket.
 */
interface LotteryTicketForDraw {
  drawId: PromiseOrValue<number>;
  ticketNumbers: PromiseOrValue<TicketCombination>;
}

/**
 * A lottery where numbers are selected from 1 to `selectionMax` and `selectionSize` numbers are selected.
 */
class Lottery {
  private static PERCENTAGE_BASE = BigNumber.from(100);
  private static EXCESS_BONUS_ALLOCATION = BigNumber.from(50);
  private static SAFETY_MARGIN = BigNumber.from(33);

  public readonly selectionSize: number;
  public readonly selectionMax: number;
  public readonly minWinningTier: number;
  public readonly rewardToken: ERC20;
  public readonly rewardTokenSymbol: string;
  public readonly rewardTokenDecimals: number;
  public readonly ticketPrice: BigNumber;

  private contract: LotteryContract;
  private graphClient: GraphQLClient;
  private firstDrawDate: Date;
  private drawPeriodInMs: number;
  private drawCoolDownPeriodInMs: number;

  /**
   * Creates a lottery instance for the 7/35 lottery.
   * @param signerOrProvider The signer or provider to use for the contract.
   * @returns A lottery instance for the 7/35 lottery.
   */
  public static lottery7_35(signerOrProvider: Signer | Provider): Lottery {
    return new Lottery(LOTTERY_7_35_CONFIG, signerOrProvider);
  }

  /**
   * Creates a lottery instance for the `config.selectionSize`/`config.selectionMax` lottery.
   * @param config The lottery configuration.
   * @param signerOrProvider The signer or provider to use for the contract.
   */
  private constructor(config: LotteryConfig, signerOrProvider: Signer | Provider) {
    this.selectionSize = config.selectionSize;
    this.selectionMax = config.selectionMax;
    this.minWinningTier = config.minWinningTier;
    this.contract = Lottery__factory.connect(config.contractAddress, signerOrProvider);
    this.graphClient = new GraphQLClient(config.subgraphUri);
    this.rewardToken = ERC20__factory.connect(config.rewardTokenAddress, signerOrProvider);
    this.rewardTokenSymbol = config.rewardTokenSymbol;
    this.rewardTokenDecimals = config.rewardTokenDecimals;
    this.firstDrawDate = new Date(config.firstDrawTimestamp * 1000);
    this.drawPeriodInMs = config.drawPeriod * 1000;
    this.drawCoolDownPeriodInMs = config.drawCoolDownPeriod * 1000;
    this.ticketPrice = config.ticketPrice;
  }

  /**
   * Returns the current draw's ID.
   * @returns The draw's ID.
   */
  public async getCurrentDraw(): Promise<number> {
    try {
      const currentDrawBN = await this.contract.currentDraw();
      return currentDrawBN.toNumber();
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns draw info (ID, draw date, winning combination, number of winners per tier and tier prizes) for given draws.
   * If a draw info is not available, it will not add it to the returned list. The function keeps the order of the draw
   * IDs.
   * @param drawIds The IDs of the draws.
   * @param orderDirection The order of the draw IDs (`'asc'` for ascending, `'desc'` for descending direction).
   * @param skip The number of draws to skip.
   * @param limit The maximum number of draws to return.
   * @returns The draws' information.
   */
  public async getDrawInfos(
    drawIds: PromiseOrValue<BigNumberish | BigNumberish[]>,
    orderDirection: 'asc' | 'desc' = 'asc',
    skip = 0,
    limit?: number,
  ): Promise<LotteryDrawInfo[]> {
    const resolvedDrawIds = await Promise.resolve(drawIds);
    const checkedDrawIds = Array.isArray(resolvedDrawIds) ? resolvedDrawIds : [resolvedDrawIds];
    const fetchLimit = limit ?? null;
    const data = await this.graphClient.request(
      gql`
        query getDrawInfos($drawIds: [ID!]!, $orderDirection: String, $limit: Int, $skip: Int!) {
          draws(
            where: { id_in: $drawIds }
            orderBy: "drawId"
            orderDirection: $orderDirection
            first: $limit
            skip: $skip
          ) {
            drawId
            scheduledTimestamp
            winningCombination
            numberOfWinnersPerTier
            prizesPerTier
          }
        }
      `,
      {
        drawIds: checkedDrawIds.map(drawId => `${this.contract.address.toLowerCase()}_${drawId.toString()}`),
        orderDirection,
        limit: fetchLimit,
        skip,
      },
    );

    return data.draws.map(
      (draw: any) =>
        ({
          drawId: parseInt(draw.drawId),
          scheduledDate: new Date(draw.scheduledTimestamp * 1000),
          numberOfWinnersPerTier: this.convertArrayToWinTierMap<number, LotteryTierWinnersCount>(
            draw.numberOfWinnersPerTier,
            Number,
          ),
          prizesPerTier: this.convertArrayToWinTierMap<BigNumber, LotteryTierPrizes>(
            draw.prizesPerTier,
            BigNumber.from,
          ),
          winningCombination: draw.winningCombination ? new Set(draw.winningCombination) : null,
        } as LotteryDrawInfo),
    );
  }

  /**
   * Returns the winning amount in the reward token for a given draw and a given win tier.
   * @param drawId The ID of the draw.
   * @param winTier The win tier (in the range [0, `selectionSize`]).
   * @returns The winning amount (in reward token's precision).
   */
  public async getWinAmount(
    drawId: PromiseOrValue<BigNumberish>,
    winTier: PromiseOrValue<number>,
  ): Promise<BigNumber | null> {
    try {
      const resolvedWinTier = await Promise.resolve(winTier);
      if (resolvedWinTier < this.minWinningTier || resolvedWinTier > this.selectionSize) {
        throw new Error(`Win tier must be between ${this.minWinningTier} and ${this.selectionSize}`);
      }

      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getWinAmount($drawId: ID!) {
            draw(id: $drawId) {
              prizesPerTier
            }
          }
        `,
        {
          drawId: `${this.contract.address.toLowerCase()}_${resolvedDrawId.toString()}`,
        },
      );

      if (!data.draw?.prizesPerTier) {
        return null;
      }

      return this.convertArrayToWinTierMap(data.draw.prizesPerTier, BigNumber.from)[resolvedWinTier] ?? null;
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the winning ticket combination for a given draw.
   * @param drawId The ID of the draw.
   * @returns The winning ticket combination.
   */
  public async getWinningTicket(drawId: PromiseOrValue<BigNumberish>): Promise<TicketCombination | null> {
    try {
      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getWinningTicket($drawId: ID!) {
            draw(id: $drawId) {
              winningCombination
            }
          }
        `,
        {
          drawId: `${this.contract.address.toLowerCase()}_${resolvedDrawId.toString()}`,
        },
      );

      if (!data.draw?.winningCombination) {
        return null;
      }

      return new Set(data.draw.winningCombination);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the claimable amount and win tier for a ticket.
   * @param ticketId The ID of the ticket.
   * @returns The claimable amount and win tier.
   */
  public async getClaimableAmountAndWinTier(
    ticketId: PromiseOrValue<BigNumberish>,
  ): Promise<{ claimableAmount: BigNumber; winTier: number }> {
    try {
      return await this.contract.claimable(ticketId);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the date of the draw's scheduled execution time.
   * @param drawId The ID of the draw.
   * @returns The draw's execution date.
   */
  public async getDrawScheduledDate(drawId: PromiseOrValue<BigNumberish>): Promise<Date> {
    try {
      const resolvedDrawId = BigNumber.from(await Promise.resolve(drawId)).toNumber();
      const scheduledTimestamp = this.firstDrawDate.getTime() + resolvedDrawId * this.drawPeriodInMs;
      return new Date(scheduledTimestamp);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the deadline for ticket registration for a given draw.
   * @param drawId The ID of the draw.
   * @returns The ticket registration deadline.
   */
  public async getTicketRegistrationDeadline(drawId: PromiseOrValue<BigNumberish>): Promise<Date> {
    try {
      const timestamp = (await this.getDrawScheduledDate(drawId)).getTime() - this.drawCoolDownPeriodInMs;
      return new Date(timestamp);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Buy set of tickets for the upcoming draws.
   * @param ticketsForDraws One or more tickets for draws.
   * @param frontend An address of a frontend operator selling the ticket.
   * @param referrer An address of a referrer who referred the ticket buyer.
   */
  public async buyTickets(
    ticketsForDraws: LotteryTicketForDraw | LotteryTicketForDraw[],
    frontend: PromiseOrValue<string>,
    referrer: PromiseOrValue<string>,
    onApproveStart?: () => void,
    onApproveSuccess?: () => void,
    onTransactionStart?: () => void,
    onTransactionSuccess?: () => void,
  ) {
    try {
      const checkedTicketsForDraws = Array.isArray(ticketsForDraws) ? ticketsForDraws : [ticketsForDraws];
      const drawIds = checkedTicketsForDraws.map(ticketForDraw =>
        Promise.resolve(ticketForDraw.drawId).then(drawId => drawId),
      );
      const packedTickets = checkedTicketsForDraws.map(ticketForDraw =>
        Promise.resolve(ticketForDraw.ticketNumbers).then(ticketNumbers =>
          convertNumbersToLotteryTicket(ticketNumbers, this.selectionSize, this.selectionMax),
        ),
      );

      const allowance = await this.rewardToken.allowance(this.contract.signer.getAddress(), this.contract.address);
      const totalTicketPrice = this.ticketPrice.mul(checkedTicketsForDraws.length);

      if (allowance.lt(totalTicketPrice)) {
        onApproveStart?.();
        const approveTx = await this.rewardToken.approve(
          this.contract.address,
          this.ticketPrice.mul(packedTickets.length),
        );
        await approveTx.wait();
        onApproveSuccess?.();
      }

      onTransactionStart?.();
      const buyTicketsTx = await this.contract.buyTickets(drawIds, packedTickets, frontend, referrer);
      await buyTicketsTx.wait();
      onTransactionSuccess?.();
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Claim winning tickets and transfers rewards to the winner. The caller must be the owner of the tickets.
   * @param ticketIds One or more ticket IDs.
   */
  public async claimWinningTickets(ticketIds: PromiseOrValue<BigNumberish> | PromiseOrValue<BigNumberish>[]) {
    try {
      const checkedTicketIds = Array.isArray(ticketIds) ? ticketIds : [ticketIds];
      await this.contract.claimWinningTickets(checkedTicketIds);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the ticket history (a list of tickets) for a given player.
   * @param playerAddress The address of the player.
   * @param skip The number of tickets to skip. Optional.
   * @param limit The maximum number of tickets to return. Optional.
   * @returns The ticket history.
   */
  public async getTickets(player: string, skip = 0, limit?: number): Promise<LotteryTicketHistory[]> {
    try {
      const fetchLimit = limit ?? null;
      const data = await this.graphClient.request(
        gql`
          query getTickets($player: ID!, $skip: Int!, $limit: Int) {
            tickets(orderBy: "ticketId", first: $limit, skip: $skip, where: { owner: $player }) {
              ticketId
              owner
              draw {
                drawId
                winningCombination
              }
              combination
              isClaimed
            }
          }
        `,
        {
          player: player.toLowerCase(),
          skip,
          limit: fetchLimit,
        },
      );

      if (!data.tickets || data.tickets.length === 0) {
        return [];
      }

      return Promise.all(
        data.tickets.map(async (ticket: any) => {
          const ticketId = BigNumber.from(ticket.ticketId);
          const drawId = Number(ticket.draw.drawId);
          const combination = ticket.combination ? new Set(ticket.combination as number[]) : null;
          const winningCombinationForDraw = ticket.draw.winningCombination
            ? new Set(ticket.draw.winningCombination as number[])
            : null;

          return new LotteryTicketHistory(
            ticketId,
            drawId,
            combination,
            ticket.isClaimed,
            tier => this.contract.winAmount(drawId, tier),
            winningCombinationForDraw,
            this.minWinningTier,
          );
        }),
      );
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  public async getPlayerStats(player: string): Promise<Player> {
    const data = await this.graphClient.request<{ player: PlayerResponse }>(
      gql`
        query getPlayers($player: ID!) {
          player(id: $player) {
            id
            drawStats {
              numberOfTickets
              numberOfWinningTickets
              numberOfClaimedTickets
              drawId
            }
          }
        }
      `,
      {
        player: player.toLowerCase(),
      },
    );

    return new Player(
      data.player.id,
      data.player.drawStats.map(
        (drawStats): DrawStats => ({
          drawId: Number(drawStats.drawId),
          numberOfClaimedTickets: Number(drawStats.numberOfClaimedTickets),
          numberOfTickets: Number(drawStats.numberOfTickets),
          numberOfWinningTickets: Number(drawStats.numberOfWinningTickets),
        }),
      ),
    );
  }

  /**
   * Returns the number of winners for each tier for a given draw.
   * @param drawId The ID of the draw.
   * @returns The number of winners for each tier.
   */
  public async getNumberOfWinnersPerTier(
    drawId: PromiseOrValue<BigNumberish>,
  ): Promise<LotteryTierWinnersCount | null> {
    try {
      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getNumberOfWinnersPerTier($drawId: ID!) {
            draw(id: $drawId) {
              numberOfWinnersPerTier
            }
          }
        `,
        {
          drawId: `${this.contract.address.toLowerCase()}_${resolvedDrawId.toString()}`,
        },
      );

      if (data.draw?.numberOfWinnersPerTier === null) {
        return null;
      }

      return this.convertArrayToWinTierMap<number, LotteryTierWinnersCount>(data.draw.numberOfWinnersPerTier, Number);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Gets the jackpot size for a given draw. If the draw is in the future the jackpot for the current draw is returned.
   * @param drawId The ID of the draw.
   * @returns The jackpot size (in reward token's precision).
   */
  public async getJackpotSize(drawId: PromiseOrValue<BigNumberish>): Promise<BigNumber | null> {
    return this.getWinAmount(drawId, this.selectionSize);
  }

  /**
   * Returns the number of players that have registered tickets for a given draw.
   * @param drawId The ID of the draw.
   * @returns The number of players for the draw.
   */
  public async getNumberOfPlayers(drawId: PromiseOrValue<BigNumberish>): Promise<number | null> {
    try {
      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getNumberOfPlayers($drawId: ID!) {
            draw(id: $drawId) {
              numberOfPlayers
            }
          }
        `,
        {
          drawId: `${this.contract.address.toLowerCase()}_${resolvedDrawId.toString()}`,
        },
      );

      return data.draw ? Number(data.draw.numberOfPlayers) : null;
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Generates `count` random tickets.
   * @param count The number of tickets to generate.
   * @returns The generated tickets.
   */
  public generateRandomTickets(count: number): TicketCombinations {
    return generateRandomTickets(count, this.selectionMax, this.selectionSize);
  }

  /**
   * Returns the reward size for a given draw and win tier.
   * @param drawId The ID of the draw.
   * @param winTier The win tier.
   * @returns The reward size.
   */
  public async getDrawRewardSize(
    drawId: PromiseOrValue<BigNumberish>,
    winTier: PromiseOrValue<number>,
  ): Promise<BigNumber> {
    const resolvedDrawId = await Promise.resolve(drawId);
    const resolvedWinTier = await Promise.resolve(winTier);
    return this.calculateReward(
      this.contract.currentNetProfit(),
      this.contract.fixedReward(resolvedWinTier),
      this.contract.fixedReward(this.selectionSize),
      this.contract.ticketsSold(resolvedDrawId),
      resolvedWinTier === this.selectionSize,
      this.contract.expectedPayout(),
    );
  }

  /**
   * Returns the number of tickets sold for a given draw.
   * @param drawId The ID of the draw.
   * @returns The number of tickets sold.
   */
  public async getSoldTickets(drawId: PromiseOrValue<BigNumberish>): Promise<number | null> {
    try {
      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getSoldTickets($drawId: ID!) {
            draw(id: $drawId) {
              numberOfSoldTickets
            }
          }
        `,
        {
          drawId: `${this.contract.address.toLowerCase()}_${resolvedDrawId.toString()}`,
        },
      );

      return data.draw ? Number(data.draw.numberOfSoldTickets) : null;
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  // Private methods

  private async calculateReward(
    netProfit: PromiseOrValue<BigNumber>,
    fixedReward: PromiseOrValue<BigNumber>,
    fixedJackpot: PromiseOrValue<BigNumber>,
    ticketsSold: PromiseOrValue<BigNumber>,
    isJackpot: boolean,
    expectedPayout: PromiseOrValue<BigNumber>,
  ): Promise<BigNumber> {
    const resolvedNetProfit = await Promise.resolve(netProfit);
    const resolvedFixedReward = await Promise.resolve(fixedReward);
    const resolvedFixedJackpot = await Promise.resolve(fixedJackpot);
    const resolvedTicketsSold = await Promise.resolve(ticketsSold);
    const resolvedExpectedPayout = await Promise.resolve(expectedPayout);
    const excess = await this.calculateExcessPot(resolvedNetProfit, resolvedFixedJackpot);

    if (isJackpot) {
      return resolvedFixedReward.add(excess.mul(Lottery.EXCESS_BONUS_ALLOCATION).div(Lottery.PERCENTAGE_BASE));
    }

    const multiplier = await this.calculateMultiplier(excess, resolvedTicketsSold, resolvedExpectedPayout);
    return resolvedFixedReward.mul(multiplier).div(Lottery.PERCENTAGE_BASE);
  }

  private async calculateExcessPot(netProfit: BigNumber, fixedJackpot: BigNumber): Promise<BigNumber> {
    const excessPotSafePercentage = Lottery.PERCENTAGE_BASE.sub(Lottery.SAFETY_MARGIN);
    const safeNetProfit = netProfit.mul(excessPotSafePercentage).div(Lottery.PERCENTAGE_BASE);
    const excessPot = safeNetProfit.sub(fixedJackpot);
    return excessPot.gt(ZERO) ? excessPot : ZERO;
  }

  private async calculateMultiplier(
    excessPot: BigNumber,
    ticketsSold: BigNumber,
    expectedPayout: BigNumber,
  ): Promise<BigNumber> {
    let bonusMulti = Lottery.PERCENTAGE_BASE;
    if (excessPot.gt(ZERO) && ticketsSold.gt(ZERO)) {
      const increase = excessPot.mul(Lottery.EXCESS_BONUS_ALLOCATION).div(ticketsSold.mul(expectedPayout));
      bonusMulti = bonusMulti.add(increase);
    }

    return bonusMulti;
  }

  private convertArrayToWinTierMap<T, M extends { [key: number]: T }>(array: string[], mapFn: (value: string) => T): M {
    const startingIndex = this.selectionSize - array.length + 1;
    return array.reduce((accumulator, current, index) => {
      const winTier = startingIndex + index;
      if (winTier < this.minWinningTier) {
        return accumulator;
      }

      accumulator[winTier] = mapFn(current);
      return accumulator;
    }, {} as M);
  }
}

export default Lottery;
