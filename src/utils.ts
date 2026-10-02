// Fix #5: Parse section content to verify it is non-empty, not just present
const SECTION_REGEX = /###\s+(ANSWER|SOURCES|UNCERTAIN)\s*\n([\s\S]*?)(?=###|$)/g;

function parseSections(output: string): Record<string, string> {
	const sections: Record<string, string> = {};
	let match: RegExpExecArray | null;
	while ((match = SECTION_REGEX.exec(output)) !== null) {
		sections[match[1]] = match[2].trim();
	}
	// Reset lastIndex for re-use
	SECTION_REGEX.lastIndex = 0;
	return sections;
}

export interface ValidationResult {
	valid: boolean;
	isPartial: boolean;
	reason?: string;
}

export function validateResearchOutput(output: string): ValidationResult {
	if (!output || output.trim().length === 0) {
		return { valid: false, isPartial: true, reason: "Output is empty" };
	}

	const sections = parseSections(output);

	// An UNCERTAIN section with content is a valid (partial) response
	if (sections["UNCERTAIN"] && sections["UNCERTAIN"].length > 0) {
		return { valid: true, isPartial: true, reason: "Agent returned UNCERTAIN" };
	}

	// Fix #5: Verify both sections are present AND have non-whitespace content
	const hasAnswer = sections["ANSWER"] && sections["ANSWER"].length > 0;
	const hasSources = sections["SOURCES"] && sections["SOURCES"].length > 0;

	if (!hasAnswer || !hasSources) {
		return {
			valid: false,
			isPartial: true,
			reason: "Missing required sections (ANSWER or SOURCES)",
		};
	}

	return { valid: true, isPartial: false };
}
