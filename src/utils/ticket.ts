import { BigNumber } from 'ethers';
import { ONE, ZERO } from '../constants';

export type TicketCombination = Set<number>;
export type TicketCombinations = Array<TicketCombination>;

/**
 * Checks if a set of numbers is a valid lottery ticket. The valid number range is [1, selectionMax].
 * @param numbers A list of numbers for a ticket.
 * @param selectionSize A count of numbers to select.
 * @param selectionMax Max number that can be selected.
 * @returns `true` if the ticket is valid, `false` otherwise.
 */
export function isValidLotteryTicket(numbers: TicketCombination, selectionSize: number, selectionMax: number): boolean {
  return numbers.size === selectionSize && Array.from(numbers).every(n => n >= 1 && n <= selectionMax);
}

/**
 * Converts a set of numbers to a lottery ticket without checking if the ticket is valid.
 * @param numbers A list of numbers for a ticket.
 * @returns A `BigNumber` representing the ticket.
 */
export function convertUncheckedNumbersToLotteryTicket(numbers: TicketCombination): BigNumber {
  return [...numbers].reduce((ticket, n) => ticket.or(ONE.shl(n - 1)), ZERO);
}

/**
 * Converts a set of numbers to a lottery ticket.
 * @param numbers A list of numbers for a ticket.
 * @param selectionSize A count of numbers to select.
 * @param selectionMax Max number that can be selected.
 * @returns A `BigNumber` representing the ticket.
 * @throws Error if the ticket is invalid.
 * @see isValidLotteryTicket
 */
export function convertNumbersToLotteryTicket(
  numbers: TicketCombination,
  selectionSize: number,
  selectionMax: number,
): BigNumber {
  if (!isValidLotteryTicket(numbers, selectionSize, selectionMax)) {
    throw new Error('convertNumbersToLotteryTicket: Invalid ticket');
  }

  return convertUncheckedNumbersToLotteryTicket(numbers);
}

/**
 * Converts a lottery ticket to a set of numbers.
 * @param ticket A `BigNumber` representing the ticket.
 * @param selectionMax Max number that can be selected.
 * @returns A set of numbers for a ticket.
 * @see convertNumbersToLotteryTicket
 */
export function convertLotteryTicketToNumbers(ticket: BigNumber, selectionMax: number): TicketCombination {
  const numbers = new Set<number>();
  for (let i = 0; i < selectionMax; i++) {
    if (ticket.and(ONE.shl(i)).gt(0)) {
      numbers.add(i + 1);
    }
  }
  return numbers;
}

/**
 * Generates a random lottery ticket.
 * @param selectionMax Max number that can be selected.
 * @param selectionSize Total numbers to be selected.
 * @returns A set of numbers for a ticket.
 */
export function generateRandomTicket(selectionSize: number, selectionMax: number): TicketCombination {
  const numbers = new Set<number>();

  while (numbers.size < selectionSize) {
    numbers.add(getRandomInt(selectionMax) + 1);
  }

  return numbers;
}

/**
 * Generates multiple random lottery tickets.
 * @param count Total tickets to be generated.
 * @param selectionMax Max number that can be selected.
 * @param selectionSize Total numbers to be selected.
 * @returns Array of valid lottery tickets.
 */
export function generateRandomTickets(count: number, selectionSize: number, selectionMax: number): TicketCombinations {
  const tickets = new Array<TicketCombination>();

  for (let i = 0; i < count; ++i) {
    tickets.push(generateRandomTicket(selectionMax, selectionSize));
  }

  return tickets;
}

/**
 * Generates a random integer. Uses Math.random(). To increase randomization, use some other libs.
 * @param max Generated number maximum value can be max - 1.
 * @returns Random integer between [0, max)
 */
function getRandomInt(max: number) {
  return Math.floor(Math.random() * max);
}
