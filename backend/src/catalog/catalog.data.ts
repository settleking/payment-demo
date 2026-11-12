/** The studio's classes. Prices are in US cents. */
export interface DanceClass {
  id: string;
  title: string;
  style: string;
  schedule: string;
  instructor: string;
  description: string;
  amount: number;
}

export const CLASSES: DanceClass[] = [
  {
    id: 'salsa',
    title: 'Salsa Foundations',
    style: 'Salsa',
    schedule: 'Mondays · 7 pm',
    instructor: 'Maya Ortiz',
    description: 'Timing, basic steps and your first turns. No partner needed.',
    amount: 2500,
  },
  {
    id: 'hiphop',
    title: 'Hip-Hop Grooves',
    style: 'Hip-Hop',
    schedule: 'Tuesdays · 6:30 pm',
    instructor: 'Jonah Reed',
    description: 'Classic grooves broken down, then a short routine.',
    amount: 2000,
  },
  {
    id: 'ballet',
    title: 'Adult Ballet',
    style: 'Ballet',
    schedule: 'Saturdays · 10 am',
    instructor: 'Elena Petrova',
    description: 'Barre and centre work for adults starting out or returning.',
    amount: 2400,
  },
  {
    id: 'ballroom',
    title: 'Waltz & Foxtrot',
    style: 'Ballroom',
    schedule: 'Sundays · 5 pm',
    instructor: 'Theo Laurent',
    description: 'Frame, posture and the first figures, ready for any wedding.',
    amount: 2200,
  },
];

export function findClass(id: string): DanceClass | undefined {
  return CLASSES.find((item) => item.id === id);
}
