import { BigNumber, ethers } from 'ethers';
import { LotteryConfig } from './lottery';

export const ZERO = BigNumber.from(0);
export const ONE = BigNumber.from(1);

const LOTTERY_7_35_REWARD_TOKEN_DECIMALS = 18;
export const LOTTERY_7_35_CONFIG: LotteryConfig = {
  selectionSize: 7,
  selectionMax: 35,
  minWinningTier: 3,
  contractAddress: '0xf180abf67f7d5a599fbf58ce1054b4329c750526',
  subgraphUri: 'https://api.studio.thegraph.com/query/71803/wenwin-dev/v0.0.7',
  rewardTokenAddress: '0x38A89e90800e5945658E2c706f636d5A4AB92AE5',
  rewardTokenSymbol: 'TT',
  rewardTokenDecimals: LOTTERY_7_35_REWARD_TOKEN_DECIMALS,
  ticketPrice: ethers.utils.parseUnits('1.5', LOTTERY_7_35_REWARD_TOKEN_DECIMALS),
  firstDrawTimestamp: 1713373200,
  drawPeriod: 3600,
  drawCoolDownPeriod: 180,
};
