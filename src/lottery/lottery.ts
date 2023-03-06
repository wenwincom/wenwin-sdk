import type { Provider } from '@ethersproject/providers';
import { BigNumber, BigNumberish, Signer, utils } from 'ethers';
import { gql, GraphQLClient } from 'graphql-request';
import { LOTTERY_7_35_ADDRESS, LOTTERY_7_35_GRAPH_URI, ZERO } from '../constants';
import { ERC20, ERC20__factory, Lottery as LotteryContract, Lottery__factory } from '../typechain';
import { PromiseOrValue } from '../typechain/common';
import {
  convertLotteryTicketToNumbers,
  convertNumbersToLotteryTicket,
  convertUncheckedNumbersToLotteryTicket,
  generateRandomTickets,
  Ticket,
  Tickets,
} from '../utils';

type LotteryTierWinnersCount = {
  [tier: number]: number;
};

type LotteryTierPrizes = {
  [tier: number]: BigNumber;
};

export interface LotteryDrawInfo {
  drawId: number;
  scheduledDate: Date;
  winningCombination: Ticket;
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
  public readonly combination: Ticket;

  /**
   * The matched numbers for the ticket. This is only available if the draw has already been finalized.
   */
  public readonly matchedNumbers: Ticket | null;

  private readonly isClaimed: boolean;
  private readonly calculateReward: (winTier: number) => Promise<BigNumber>;

  /**
   * Creates a lottery ticket history instance.
   * @param ticketId The ID of the ticket.
   * @param draw The ID of the draw the ticket was purchased for.
   * @param combination The numbers on the ticket.
   * @param isClaimed Whether the ticket has been claimed.
   * @param calculateReward A function that calculates the reward for a given win tier.
   * @param drawWinningCombination The winning combination for the draw.
   */
  constructor(
    ticketId: BigNumber,
    draw: number,
    combination: Ticket,
    isClaimed: boolean,
    calculateReward: (winTier: number) => Promise<BigNumber>,
    drawWinningCombination: Ticket | null,
  ) {
    this.ticketId = ticketId;
    this.draw = draw;
    this.combination = combination;
    this.matchedNumbers = drawWinningCombination
      ? new Set([...this.combination].filter(number => drawWinningCombination?.has(number)))
      : null;
    this.isClaimed = isClaimed;
    this.calculateReward = calculateReward;
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
    return this.winTier !== null && this.winTier === this.combination.size;
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
    if (this.draw >= currentDraw) {
      return 'active';
    }

    if (this.isClaimed) {
      return 'claimed';
    }

    if (this.draw + LotteryTicketHistory.DRAWS_PER_YEAR < currentDraw) {
      return 'expired';
    }

    if (this.winTier !== null && this.winTier > 0) {
      return 'unclaimed';
    }

    return 'unclaimable';
  }
}

/**
 * Represents a lottery ticket for a draw.
 * @property drawId The ID of the draw.
 * @property ticketNumbers The numbers on the ticket.
 */
interface LotteryTicketForDraw {
  drawId: PromiseOrValue<number>;
  ticketNumbers: PromiseOrValue<Ticket>;
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
  public readonly swapWinTier: number;
  private contract: LotteryContract;
  private graphClient: GraphQLClient;

  private rewardTokenAddress: string | null = null;
  private firstDrawDate: Date | null = null;
  private drawPeriodInMs: number | null = null;
  private drawCoolDownPeriodInMs: number | null = null;
  private ticketPrice: BigNumber | null = null;

  /**
   * Creates a lottery instance for the 7/35 lottery.
   * @param signerOrProvider The signer or provider to use for the contract.
   * @returns A lottery instance for the 7/35 lottery.
   */
  public static async lottery7_35(signerOrProvider: Signer | Provider): Promise<Lottery> {
    const lottery = new Lottery(7, 35, 3, LOTTERY_7_35_ADDRESS, signerOrProvider, LOTTERY_7_35_GRAPH_URI);

    try {
      lottery.rewardTokenAddress = await lottery.contract.rewardToken();
      lottery.firstDrawDate = new Date((await lottery.contract.drawScheduledAt(0)).toNumber() * 1000);
      lottery.drawPeriodInMs = (await lottery.contract.drawPeriod()).toNumber() * 1000;
      lottery.drawCoolDownPeriodInMs = (await lottery.contract.drawCoolDownPeriod()).toNumber() * 1000;
      lottery.ticketPrice = await lottery.contract.ticketPrice();
    } catch (e) {
      console.error(e);
    }

    return lottery;
  }

  /**
   * Creates a lottery instance for the `selectionSize`/`selectionMax` lottery.
   * @param selectionSize The number of numbers to select.
   * @param selectionMax The maximum number that can be selected.
   * @param swapWinTier The win tier at which the prize is equal to the ticket size (lowest awarded win tier).
   * @param address The address of the lottery contract.
   * @param signerOrProvider The signer or provider to use for the contract.
   * @param graphUri The URI of the lottery subgraph.
   */
  private constructor(
    selectionSize: number,
    selectionMax: number,
    swapWinTier: number,
    address: string,
    signerOrProvider: Signer | Provider,
    graphUri: string,
  ) {
    this.selectionSize = selectionSize;
    this.selectionMax = selectionMax;
    this.swapWinTier = swapWinTier;
    this.contract = Lottery__factory.connect(address, signerOrProvider);
    this.graphClient = new GraphQLClient(graphUri);
  }

  /**
   * Returns the ERC-20 token used as the reward token.
   * @returns The lottery's reward token.
   */
  public async getRewardToken(): Promise<ERC20> {
    try {
      const tokenAddress = this.rewardTokenAddress ?? (await this.contract.rewardToken());
      return ERC20__factory.connect(tokenAddress, this.contract.signer || this.contract.provider);
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Returns the ticket price in the reward token.
   * @returns The ticket price (in reward token's precision).
   */
  public async getTicketPrice(): Promise<BigNumber> {
    try {
      return this.ticketPrice ?? (await this.contract.ticketPrice());
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
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
   * @returns The draws' information.
   */
  public async getDrawInfos(drawIds: PromiseOrValue<BigNumberish | BigNumberish[]>): Promise<LotteryDrawInfo[]> {
    const resolvedDrawIds = await Promise.resolve(drawIds);
    const checkedDrawIds = Array.isArray(resolvedDrawIds) ? resolvedDrawIds : [resolvedDrawIds];
    const data = await this.graphClient.request(
      gql`
        query getWinningTicket($drawIds: [ID!]!) {
          draws(where: { id_in: $drawIds }) {
            id
            scheduledTimestamp
            winningTicket
            numberOfWinnersPerTier
            prizesPerTier
          }
        }
      `,
      {
        drawIds: checkedDrawIds.map(drawId => drawId.toString()),
      },
    );

    return data.draws.map(
      (draw: any) =>
        ({
          drawId: parseInt(draw.id),
          scheduledDate: new Date(draw.scheduledTimestamp * 1000),
          numberOfWinnersPerTier: this.convertArrayToWinTierMap<number, LotteryTierWinnersCount>(
            draw.numberOfWinnersPerTier,
            Number,
          ),
          prizesPerTier: this.convertArrayToWinTierMap<BigNumber, LotteryTierPrizes>(
            draw.prizesPerTier,
            BigNumber.from,
          ),
          winningCombination: draw.winningTicket
            ? convertLotteryTicketToNumbers(BigNumber.from(draw.winningTicket), this.selectionMax)
            : null,
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
      if (resolvedWinTier < this.swapWinTier || resolvedWinTier > this.selectionSize) {
        throw new Error(`Win tier must be between ${this.swapWinTier} and ${this.selectionSize}`);
      }

      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getWinningTicket($drawId: ID!) {
            draw(id: $drawId) {
              prizesPerTier
            }
          }
        `,
        {
          drawId: resolvedDrawId.toString(),
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
  public async getWinningTicket(drawId: PromiseOrValue<BigNumberish>): Promise<Ticket | null> {
    try {
      const resolvedDrawId = await Promise.resolve(drawId);
      const data = await this.graphClient.request(
        gql`
          query getWinningTicket($drawId: ID!) {
            draw(id: $drawId) {
              winningTicket
            }
          }
        `,
        {
          drawId: resolvedDrawId.toString(),
        },
      );

      if (!data.draw?.winningTicket) {
        return null;
      }

      return convertLotteryTicketToNumbers(BigNumber.from(data.draw.winningTicket), this.selectionMax);
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
      if (this.firstDrawDate && this.drawPeriodInMs) {
        const resolvedDrawId = BigNumber.from(await Promise.resolve(drawId)).toNumber();
        const scheduledTimestamp = this.firstDrawDate.getTime() + resolvedDrawId * this.drawPeriodInMs;
        return new Date(scheduledTimestamp);
      }

      const timestampInSecond = await this.contract.drawScheduledAt(drawId);
      const timestampInMillisecond = timestampInSecond.toNumber() * 1000;
      return new Date(timestampInMillisecond);
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
      if (this.firstDrawDate && this.drawPeriodInMs && this.drawCoolDownPeriodInMs) {
        const timestamp = (await this.getDrawScheduledDate(drawId)).getTime() - this.drawCoolDownPeriodInMs;
        return new Date(timestamp);
      }

      const timestampInSecond = await this.contract.ticketRegistrationDeadline(drawId);
      const timestampInMillisecond = timestampInSecond.toNumber() * 1000;
      return new Date(timestampInMillisecond);
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
  ) {
    try {
      const checkedTicketsForDraws = Array.isArray(ticketsForDraws) ? ticketsForDraws : [ticketsForDraws];
      const drawIds = checkedTicketsForDraws.map(ticketForDraw =>
        Promise.resolve(ticketForDraw.drawId).then(drawId => utils.parseEther(drawId.toString())),
      );
      const packedTickets = checkedTicketsForDraws.map(ticketForDraw =>
        Promise.resolve(ticketForDraw.ticketNumbers).then(ticketNumbers =>
          convertNumbersToLotteryTicket(ticketNumbers, this.selectionSize, this.selectionMax),
        ),
      );

      const rewardToken = await this.getRewardToken();
      const ticketPrice = await this.getTicketPrice();
      const allowance = await rewardToken.allowance(this.contract.signer.getAddress(), this.contract.address);
      const totalTicketPrice = ticketPrice.mul(checkedTicketsForDraws.length);

      if (allowance.lt(totalTicketPrice)) {
        const approveTx = await rewardToken.approve(this.contract.address, ticketPrice.mul(packedTickets.length));
        await approveTx.wait();
      }

      const buyTicketsTx = await this.contract.buyTickets(drawIds, packedTickets, frontend, referrer);
      await buyTicketsTx.wait();
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
            tickets(orderBy: "draw", first: $limit, skip: $skip, where: { owner: $player }) {
              id
              owner
              draw
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
          const ticketId = BigNumber.from(ticket.id);
          const drawId = Number(ticket.draw);
          const combination = convertLotteryTicketToNumbers(BigNumber.from(ticket.combination), this.selectionMax);
          const winningCombinationForDraw = await this.getWinningTicket(drawId);

          return new LotteryTicketHistory(
            ticketId,
            drawId,
            combination,
            ticket.isClaimed,
            tier => this.contract.winAmount(drawId, tier),
            winningCombinationForDraw,
          );
        }),
      );
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
  }

  /**
   * Gets the number of tickets that have been registered for a given draw with the given combination.
   * @param drawId The ID of the draw.
   * @param combination The combination numbers (up to `selectionSize` numbers).
   * @returns The number of tickets that have been registered.
   */
  public async getNumberOfTicketCombinations(
    drawId: PromiseOrValue<BigNumberish>,
    combination: Ticket,
  ): Promise<number> {
    try {
      if (combination.size > this.selectionSize) {
        throw new Error(
          `Combination has too many numbers. Expected at most ${this.selectionSize} but got ${combination.size}`,
        );
      }

      const resolvedDrawId = Promise.resolve(drawId);
      const packedTicket = convertUncheckedNumbersToLotteryTicket(combination);
      const combinationId = `${resolvedDrawId.toString()}_${packedTicket.toHexString()}`;
      const data = await this.graphClient.request(
        gql`
          query getNumberOfTicketCombinations($combinationId: ID!) {
            ticketCombination(id: $combinationId) {
              numberOfTickets
            }
          }
        `,
        {
          combinationId,
        },
      );
      return data.ticketCombination ? Number(data.ticketCombination.numberOfTickets) : 0;
    } catch (error) {
      console.error(error);
      return Promise.reject(error);
    }
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
          drawId: resolvedDrawId.toString(),
        },
      );

      if (data.draw === null) {
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

  public async getNumberOfPlayers(drawId: PromiseOrValue<BigNumberish>): Promise<number> {
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
          drawId: resolvedDrawId.toString(),
        },
      );

      return data.draw ? Number(data.draw.numberOfPlayers) : 0;
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
  public async generateRandomTickets(count: number): Promise<Tickets> {
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
  public async getSoldTickets(drawId: PromiseOrValue<BigNumberish>): Promise<number> {
    try {
      const soldTicketsBN = await this.contract.ticketsSold(drawId);
      return soldTicketsBN.toNumber();
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
      if (winTier < this.swapWinTier) {
        return accumulator;
      }

      accumulator[winTier] = mapFn(current);
      return accumulator;
    }, {} as M);
  }
}

export default Lottery;
