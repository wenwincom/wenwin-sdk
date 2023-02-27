import { BigNumber } from 'ethers';
import {
  convertLotteryTicketToNumbers,
  convertNumbersToLotteryTicket,
  isValidLotteryTicket,
  generateRandomTicket,
} from '../../src/utils';

describe('Ticket', () => {
  describe('isValidLotteryTicket', () => {
    it('should return `true` for valid tickets', () => {
      const cases = [
        { numbers: new Set([1, 2, 3, 4, 5]), selectionSize: 5, selectionMax: 10 },
        { numbers: new Set([1, 2, 4, 6, 8]), selectionSize: 5, selectionMax: 10 },
        { numbers: new Set([5]), selectionSize: 1, selectionMax: 6 },
        { numbers: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), selectionSize: 11, selectionMax: 11 },
      ];
      cases.forEach(({ numbers, selectionSize, selectionMax }) => {
        expect(isValidLotteryTicket(numbers, selectionSize, selectionMax)).toBe(true);
      });
    });

    it('should return `false` for invalid tickets', () => {
      const cases = [
        { numbers: new Set([1, 2, 3, 4, 5, 6]), selectionSize: 5, selectionMax: 10 },
        { numbers: new Set([0, 1, 2, 3, 4]), selectionSize: 5, selectionMax: 10 },
        { numbers: new Set([1, 2, 4, 6, 8, 11]), selectionSize: 6, selectionMax: 10 },
        { numbers: new Set([5, 6]), selectionSize: 1, selectionMax: 6 },
        { numbers: new Set([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), selectionSize: 11, selectionMax: 10 },
      ];
      cases.forEach(({ numbers, selectionSize, selectionMax }) => {
        expect(isValidLotteryTicket(numbers, selectionSize, selectionMax)).toBe(false);
      });
    });
  });

  describe('convertNumbersToLotteryTicket', () => {
    it('should convert a set of numbers to a lottery ticket', () => {
      const cases = [
        { numbers: new Set([1, 2, 3, 4, 5]), selectionSize: 5, selectionMax: 10, expected: '0x1f' },
        { numbers: new Set([1, 2, 4, 6, 8]), selectionSize: 5, selectionMax: 10, expected: '0xab' },
        { numbers: new Set([5]), selectionSize: 1, selectionMax: 6, expected: '0x10' },
        {
          numbers: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
          selectionSize: 11,
          selectionMax: 11,
          expected: '0x07ff',
        },
      ];
      cases.forEach(({ numbers, selectionSize, selectionMax, expected }) => {
        expect(convertNumbersToLotteryTicket(numbers, selectionSize, selectionMax).toHexString()).toBe(expected);
      });
    });

    it('should throw an error for invalid tickets', () => {
      const cases = [
        { numbers: new Set([1, 2, 3, 4, 5, 6]), selectionSize: 5, selectionMax: 10 },
        { numbers: new Set([0, 2, 4, 6, 8, 11]), selectionSize: 6, selectionMax: 10 },
        { numbers: new Set([5, 6]), selectionSize: 1, selectionMax: 6 },
        { numbers: new Set([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), selectionSize: 11, selectionMax: 10 },
      ];
      cases.forEach(({ numbers, selectionSize, selectionMax }) => {
        expect(() => convertNumbersToLotteryTicket(numbers, selectionSize, selectionMax)).toThrow();
      });
    });
  });

  describe('convertLotteryTicketToNumbers', () => {
    it('should convert a lottery ticket to a set of numbers', () => {
      const cases = [
        { ticket: '0x1f', selectionMax: 10, expected: new Set([1, 2, 3, 4, 5]) },
        { ticket: '0xab', selectionMax: 10, expected: new Set([1, 2, 4, 6, 8]) },
        { ticket: '0x10', selectionMax: 6, expected: new Set([5]) },
        {
          ticket: '0x07ff',
          selectionSize: 11,
          selectionMax: 11,
          expected: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        },
      ];
      cases.forEach(({ ticket, selectionMax, expected }) => {
        expect(convertLotteryTicketToNumbers(BigNumber.from(ticket), selectionMax)).toEqual(expected);
      });
    });

    it('should convert from a random lottery ticket to a set of numbers and back', () => {
      for (let i = 0; i < 1000; i++) {
        const randomNumber = Math.floor(Math.random() * 1000000);
        const randomTicket = BigNumber.from(Math.floor(randomNumber));
        const selectionSize = randomNumber.toString(2).split('1').length - 1;
        const selectionMax = Math.floor(Math.log2(randomNumber)) + 1;
        expect(
          convertNumbersToLotteryTicket(
            convertLotteryTicketToNumbers(randomTicket, selectionMax),
            selectionSize,
            selectionMax,
          ),
        ).toEqual(randomTicket);
      }
    });

    it('generated random ticket is a valid ticket', () => {
      for (let i = 0; i < 1000; i++) {
        const selectionSize = 7;
        const selectionMax = 35;
        expect(
          isValidLotteryTicket(generateRandomTicket(selectionSize, selectionMax), selectionSize, selectionMax),
        ).toEqual(true);
      }
    });
  });
});
