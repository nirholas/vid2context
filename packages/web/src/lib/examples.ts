/**
 * Real public videos the app suggests, both recorded in tests/fixtures/contexts.
 * `topic` is a word that occurs in the transcript and `question` one the video
 * answers, so search, research and ask examples return something real.
 */
export interface Example {
  label: string;
  url: string;
  topic: string;
  question: string;
}

export const EXAMPLES: Example[] = [
  {
    label: 'Me at the zoo (0:19)',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    topic: 'elephants',
    question: 'What does he say about the elephants?',
  },
  {
    label: 'Best and Worst G-Wagon Years (18:13)',
    url: 'https://www.youtube.com/watch?v=cCPsdFdlshc',
    topic: 'reliability',
    question: 'Which G-Wagon years are the most reliable, and which should be avoided?',
  },
];
