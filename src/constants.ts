import { BigNumber, ethers } from 'ethers';
import { LotteryConfig } from './lottery';

export const ZERO = BigNumber.from(0);
export const ONE = BigNumber.from(1);

const LOTTERY_7_35_REWARD_TOKEN_DECIMALS = 18;
export const LOTTERY_7_35_CONFIG: LotteryConfig = {
  selectionSize: 7,
  selectionMax: 35,
  minWinningTier: 3,
  contractAddress: '0xf73b512f204e739B32D004D7dF3924A8CE30B66d',
  subgraphUri: 'https://api.studio.thegraph.com/query/41767/wenwintest/0.2.21',
  rewardTokenAddress: '0x9BcbFD8192e4e5075EaEc734E35fB3A5A6ed630c',
  rewardTokenSymbol: 'RWT',
  rewardTokenDecimals: LOTTERY_7_35_REWARD_TOKEN_DECIMALS,
  ticketPrice: ethers.utils.parseUnits('1.5', LOTTERY_7_35_REWARD_TOKEN_DECIMALS),
  firstDrawTimestamp: 1678111200,
  drawPeriod: 900,
  drawCoolDownPeriod: 300,
};
