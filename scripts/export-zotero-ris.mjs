#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const source = path.join(root, "data", "papers-2025-security.json")
const outDir = path.join(root, "local-library", "zotero-import")

const papers = JSON.parse(await readFile(source, "utf8"))
await mkdir(outDir, { recursive: true })

await writeRis("2025-security-all.notes-only.ris", papers, { includePdfLinkAttachment: false })
await writeRis("2025-security-all.with-pdf-links.ris", papers, { includePdfLinkAttachment: true })

for (const venue of [...new Set(papers.map((paper) => paper.venue))].sort()) {
  const venuePapers = papers.filter((paper) => paper.venue === venue)
  const slug = venue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  await writeRis(`2025-${slug}.notes-only.ris`, venuePapers, { includePdfLinkAttachment: false })
  await writeRis(`2025-${slug}.with-pdf-links.ris`, venuePapers, { includePdfLinkAttachment: true })
}

await writeFile(path.join(outDir, "README.md"), readme(), "utf8")

console.log(`Wrote Zotero import files to ${outDir}`)

async function writeRis(fileName, items, options) {
  const body = items.map((paper) => toRis(paper, options)).join("\n")
  await writeFile(path.join(outDir, fileName), body, "utf8")
}

function toRis(paper, { includePdfLinkAttachment }) {
  const lines = []
  lines.push("TY  - CONF")
  lines.push(`T1  - ${clean(paper.title)}`)
  for (const author of paper.authors ?? []) {
    lines.push(`AU  - ${clean(author)}`)
  }
  lines.push(`PY  - ${paper.year}`)
  lines.push(`T2  - ${clean(paper.venue)}`)
  if (paper.pages) {
    const [start, end] = String(paper.pages).split("-")
    lines.push(`SP  - ${clean(start)}`)
    if (end) lines.push(`EP  - ${clean(end)}`)
  }
  if (paper.doi) lines.push(`DO  - ${clean(paper.doi)}`)
  lines.push(`UR  - ${clean(primaryUrl(paper))}`)
  lines.push(`DB  - DBLP`)
  lines.push(`ID  - ${clean(paper.dblpKey || paper.doi || paper.title)}`)
  lines.push(`KW  - ${clean(paper.venue)}`)
  lines.push(`KW  - ${paper.year}`)
  if (paper.track) lines.push(`KW  - ${clean(paper.track)}`)

  const notes = [
    `DBLP: ${paper.dblpUrl}`,
    paper.doi ? `DOI: https://doi.org/${paper.doi}` : "",
    paper.ee?.[0] ? `Official: ${paper.ee[0]}` : "",
    paper.pdf?.url ? `Open PDF: ${paper.pdf.url}` : "Open PDF: not found",
    paper.pdf?.source ? `PDF source: ${paper.pdf.source}` : "",
    paper.pdf?.status ? `PDF status: ${paper.pdf.status}` : "",
  ].filter(Boolean)
  lines.push(`N1  - ${notes.map(clean).join(" | ")}`)

  if (includePdfLinkAttachment && paper.pdf?.url) {
    lines.push(`L1  - ${clean(paper.pdf.url)}`)
  }

  lines.push("ER  -")
  return lines.join("\n")
}

function primaryUrl(paper) {
  if (paper.doi) return `https://doi.org/${paper.doi}`
  if (paper.ee?.[0]) return paper.ee[0]
  return paper.dblpUrl
}

function clean(value = "") {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function readme() {
  return `# Zotero Import Files

Generated from \`data/papers-2025-security.json\`.

## Recommended import order

1. In Zotero, create a collection such as \`Security Top 4 / 2025\`.
2. Import \`2025-security-all.notes-only.ris\` first.
3. If you want Zotero to create URL attachments for PDFs, import \`2025-security-all.with-pdf-links.ris\` into a test collection first.

## File types

- \`*.notes-only.ris\`: PDF URLs are stored only in the item note. This should not download PDFs.
- \`*.with-pdf-links.ris\`: Adds RIS \`L1\` fields for open PDF URLs. Zotero may import these as linked URL attachments depending on importer behavior.

## Per-venue files

Use per-venue files if you want separate Zotero collections:

- \`2025-ccs.notes-only.ris\`
- \`2025-ieee-s-p.notes-only.ris\`
- \`2025-ndss.notes-only.ris\`
- \`2025-usenix-security.notes-only.ris\`

The matching \`with-pdf-links\` files include the same records plus PDF link fields.
`
}
