import { toNairaJson } from "../../utils/money";

// An expected tool result with Chowdeck's kobo amounts shown in naira, as tools return them.
export const inNaira = <T>(value: T): T => JSON.parse(toNairaJson(value));
