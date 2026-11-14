import { list, obj, SOURCES, str } from './cite.ts';
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
  instructions: `## Buyer guide

Turn the videos into advice for someone deciding what to buy.

- Models and trims: every model, generation, trim or engine variant the videos discuss, with the years it covers and the videos' verdict.
- Model years: which years or year ranges to seek, consider or avoid, and why.
- Prices: any price, price range or cost the videos state, with what it is for. Copy numbers exactly as said.
- Known problems: specific failures and weak points, which years or variants they affect, and how serious they are.
- What to avoid: models, years, options or conditions the videos warn against.
- Mileage: what the videos say about mileage, how much is acceptable and what matters more than the number.
- Questions for the seller: what to ask or check before buying (service records, specific repairs, inspections).
- When videos disagree about a year, model or problem, keep both sides and cite each.
- Never fill a field from general knowledge. Leave a list empty when the videos say nothing about it.`,
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
