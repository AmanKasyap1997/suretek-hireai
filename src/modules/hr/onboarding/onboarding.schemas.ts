import { z } from 'zod';

export const completionSchema = z.object({ completed: z.boolean() }).strict();
export type CompletionInput = z.infer<typeof completionSchema>;
