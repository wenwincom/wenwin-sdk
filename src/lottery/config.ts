import { BigNumber } from 'ethers';

export interface LotteryConfig {
  /** The number of numbers to select. */
  selectionSize: number;

  /** The maximum number that can be selected. */
  selectionMax: number;

  /** The minimum tier to win. */
  minWinningTier: number;

  /** The lottery's contract address. */
  contractAddress: string;

  /** The subgraph URI for fetching indexed data. */
  subgraphUri: string;

  /** The lottery's reward token address. */
  rewardTokenAddress: string;

  /** The lottery's reward token symbol. */
  rewardTokenSymbol: string;

  /** The lottery's reward token decimals. */
  rewardTokenDecimals: number;

  /** The lottery's ticket price in reward token. */
  ticketPrice: BigNumber;

  /** The timestamp of the first draw (in seconds). */
  firstDrawTimestamp: number;

  /** The number of seconds between draws. */
  drawPeriod: number;

  /** The period before draw execution when tickets cannot be bought. */
  drawCoolDownPeriod: number;
}
