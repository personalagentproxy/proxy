---
name: skill-authoring
description: Create and improve Claude Code skills following Anthropic's best practices. Use when authoring new skills, refactoring existing skills, or reviewing skill quality.
---

# Skill Authoring

## Quick Reference

**Structure:**

```
skill-name/
└── SKILL.md           # Main file (under 500 lines)
    ├── frontmatter    # name + description (required)
    └── body           # Instructions, examples, references
```

**Frontmatter:**

```yaml
---
name: lowercase-with-hyphens # max 64 chars, no "anthropic"/"claude"
description: What it does and when to use it. Written in third person.
---
```

## Core Principles

### Be Concise

Claude is smart. Only add context Claude doesn't already have.

**Good** (~50 tokens):

````markdown
Use pdfplumber for text extraction:

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**Bad** (~150 tokens): Explaining what PDFs are, why pdfplumber exists, etc.

### Set Appropriate Freedom

| Freedom Level       | When to Use               | Example                |
| ------------------- | ------------------------- | ---------------------- |
| High (text)         | Multiple valid approaches | Code review guidelines |
| Medium (pseudocode) | Preferred pattern exists  | Report templates       |
| Low (exact script)  | Fragile operations        | Database migrations    |

### Naming

Use gerund form (verb + -ing):

- `processing-pdfs`
- `analyzing-data`
- `writing-documentation`

Avoid: `helper`, `utils`, `tools`, vague names

### Descriptions

Always third person. Include what AND when:

```yaml
# Good
description: Extracts text from PDFs and fills forms. Use when working with PDF files or document extraction.

# Bad
description: Helps with documents
```

## Progressive Disclosure

Keep SKILL.md as overview, link to detail files:

```markdown
## Quick start

[Core instructions here]

## Advanced

**Form filling**: See [FORMS.md](FORMS.md)
**API reference**: See [REFERENCE.md](REFERENCE.md)
```

Rules:

- Keep references one level deep (no nested chains)
- Add table of contents to files over 100 lines
- Use forward slashes in paths (`reference/guide.md`)

## Patterns

### Template Pattern

```markdown
## Output format

Use this structure:
[template here]
```

### Examples Pattern

```markdown
## Examples

**Input**: Added authentication
**Output**: `feat(auth): implement JWT authentication`
```

### Workflow Pattern

```markdown
## Workflow

1. Analyze input
2. Validate results
3. If errors, fix and return to step 2
4. Generate output
```

## Anti-Patterns

- Offering too many library choices (pick one default)
- Time-sensitive info ("before August 2025...")
- Inconsistent terminology
- Windows-style paths (`docs\file.md`)
- Deep reference chains (A → B → C)
- Over-explaining concepts Claude knows

## Checklist

Before finalizing:

- [ ] Description includes what AND when
- [ ] SKILL.md under 500 lines
- [ ] Third person throughout
- [ ] Consistent terminology
- [ ] No time-sensitive content
- [ ] References one level deep
- [ ] Forward slashes in paths
