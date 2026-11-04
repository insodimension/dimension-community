// Gmail's OWN skill card — a Tier-3 custom renderer (doc 35 §4) that lives IN the
// plugin and is bundled into the app at build time (packages/app/bundled-skill-cards).
// It composes the shared @fraym/ui SkillCard primitive with Gmail's brand: a Google
// spectrum top bar, Gmail-red accent, and email-specific example prompts. The brand
// hex is gmail's own identity (not the shared fr- token palette) — intentional and
// appropriate for a plugin's bespoke card.
import { SkillCard, type SkillCardRenderer } from "@fraym/ui";

// Google spectrum: blue → green → yellow → red.
const GOOGLE_BAR = "linear-gradient(90deg, #4285f4, #34a853 38%, #fbbc04 68%, #ea4335)";

export const gmailSkillCard: SkillCardRenderer = (input, ctx) => (
	<SkillCard
		name={input.name}
		description={input.description ?? "Read, search and organize your Gmail, and send mail once you approve it."}
		icon={input.icon}
		eyebrow="Email skill"
		accent="#ea4335"
		bar={GOOGLE_BAR}
		examples={["Check my latest emails", "Search for invoices", "Draft a reply"]}
		enabled={input.installed}
		onOpen={ctx.onOpen}
		onToggle={ctx.onToggle}
	/>
);
