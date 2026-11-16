import { z } from 'zod';
import { ScorecardRecommendation } from '../../../shared/enums';

export const submitScorecardSchema = z
  .object({
    scores: z
      .array(
        z
          .object({
            criterionId: z.string().min(1).max(100),
            score: z.number().int().min(0).max(5),
          })
          .strict(),
      )
      .max(100)
      .refine(
        (scores) =>
          new Set(scores.map((score) => score.criterionId)).size ===
          scores.length,
        { message: 'Duplicate criterion IDs are not allowed' },
      ),
    recommendation: z.enum(ScorecardRecommendation),
    notes: z.string().trim().max(5000).default(''),
  })
  .strict();

export type SubmitScorecardInput = z.infer<typeof submitScorecardSchema>;
