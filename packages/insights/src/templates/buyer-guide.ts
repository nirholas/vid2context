import { list, obj, SOURCES, str } from './cite.ts';
import { templatePrompt } from './prompt.ts';
import type { Template } from './types.ts';

export const buyerGuide: Template = {
  id: 'buyer-guide',
  title: 'Buyer guide',
  description:
    'Which model, trim and year to buy: generations, years to seek and avoid, prices, known problems, mileage advice and questions to ask a seller, each item cited.',
  topics: [
    'models and trims',
    'model years',
    'engines',
    'interior',
    'prices',
    'known problems',
    'what to avoid',
    'mileage',
    'maintenance costs',
    'questions for the seller',
  ],
  instructions: templatePrompt('buyer-guide'),
  schema: obj(
    {
      product: str('What is being bought, as the videos name it'),
      summary: str('Three to five sentences of overall advice from the videos'),
      models: list(
        obj(
          {
            name: str('Model, generation, trim or engine variant'),
            years: str('Years it covers, as stated'),
            verdict: str('What the videos think of it'),
            sources: SOURCES,
          },
          ['years'],
        ),
      ),
      years: list(
        obj({
          range: str('A year or year range, for example 2002-2006'),
          verdict: { type: 'string', enum: ['seek', 'consider', 'avoid', 'mixed'] },
          why: str('The reason the videos give'),
          sources: SOURCES,
        }),
      ),
      prices: list(obj({ item: str('What the price is for'), price: str('The price or range as stated'), sources: SOURCES })),
      knownProblems: list(
        obj(
          {
            problem: str('The failure or weak point'),
            affects: str('Years, engines or variants affected'),
            severity: { type: 'string', enum: ['minor', 'moderate', 'major'] },
            sources: SOURCES,
          },
          ['affects', 'severity'],
        ),
      ),
      avoid: list(obj({ what: str('What to avoid'), why: str('Why'), sources: SOURCES })),
      mileageAdvice: list(obj({ advice: str('What the videos say about mileage'), sources: SOURCES })),
      sellerQuestions: list(
        obj({ question: str('What to ask or check'), why: str('What the answer tells you'), sources: SOURCES }, ['why']),
      ),
    },
    [],
  ),
};
