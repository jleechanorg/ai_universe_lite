import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const intakeIdGen = customAlphabet(ALPHABET, 16);
const runIdGen = customAlphabet(ALPHABET, 12);
const shareTokenGen = customAlphabet(ALPHABET, 20);

export const newIntakeId = (): string => `intk_${intakeIdGen()}`;
export const newRunId = (): string => `run_${runIdGen()}`;
export const newShareToken = (): string => shareTokenGen();
