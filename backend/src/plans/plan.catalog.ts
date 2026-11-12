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

export function findPlan(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}
