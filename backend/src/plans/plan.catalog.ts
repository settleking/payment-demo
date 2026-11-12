import type { AgreementInterval, AgreementType } from '../settleking/settleking.types';

/**
 * The studio's plans, each a SettleKing payment agreement the customer approves once:
 * - recurring: SettleKing charges the same amount every interval (optionally after a free trial);
 * - on_demand: the studio charges for each class attended, within limits the customer approved.
 * Amounts are US cents.
 */
export interface Plan {
  id: string;
  type: AgreementType;
  title: string;
  tagline: string;
  perks: string[];
  /** recurring */
  amount?: number;
  interval?: AgreementInterval;
  /** recurring: every this many intervals; 1 when absent. */
  intervalCount?: number;
  /** recurring: days before the first charge. */
  trialDays?: number;
  /** on_demand */
  maxPerCharge?: number;
  maxPerMonth?: number;
}

export const PLANS: Plan[] = [
  {
    id: 'unlimited',
    type: 'recurring',
    title: 'Unlimited Monthly',
    tagline: 'Every class, every week. First week free.',
    perks: ['All four styles', 'Charged monthly from the end of your trial', 'Cancel any time in SettleKing'],
    amount: 7900,
    interval: 'month',
    trialDays: 7,
  },
  {
    id: 'weekly',
    type: 'recurring',
    title: 'Weekly Practice',
    tagline: 'One class a week, charged weekly from today.',
    perks: ['Any one class each week', 'First charge when you approve', 'Pause-safe: a failed charge is tried once'],
    amount: 1500,
    interval: 'week',
  },
  {
    id: 'flex',
    type: 'on_demand',
    title: 'Pay As You Dance',
    tagline: 'Drop in when you like; we charge after each class.',
    perks: ['Charged only for classes you attend', 'Never more than $40 at a time', 'Never more than $160 a month'],
    maxPerCharge: 4000,
    maxPerMonth: 16000,
  },
];

/**
 * A plan charged every few minutes, for watching several billing cycles in one sitting. Offered
 * only when PLAN_TEST_MINUTES is set, and only SettleKing's test environments accept it.
 */
export function minutePlan(minutes: number): Plan {
  return {
    id: 'minutes',
    type: 'recurring',
    title: 'Quick Test',
    tagline: `Charged every ${minutes} minutes, to watch renewals happen.`,
    perks: ['For testing only', 'First charge when you approve', 'Cancel when you have seen enough'],
    amount: 100,
    interval: 'minute',
    intervalCount: minutes,
  };
}

/** The plans this site offers: the studio's catalog, plus the test plan when it is switched on. */
export function plansFor(testMinutes: number | null): Plan[] {
  return testMinutes ? [...PLANS, minutePlan(testMinutes)] : PLANS;
}

export function findPlan(id: string, testMinutes: number | null = null): Plan | undefined {
  return plansFor(testMinutes).find((plan) => plan.id === id);
}
