#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createWriteStream, existsSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"

const root = process.cwd()
const year = 2025

const venues = {
  CCS: {
    query: "toc:db/conf/ccs/ccs2025.bht:",
    page: "https://dblp.org/db/conf/ccs/ccs2025.html",
    dir: "CCS",
    tag: "venue/ccs",
  },
  "IEEE S&P": {
    query: "toc:db/conf/sp/sp2025.bht:",
    page: "https://dblp.org/db/conf/sp/sp2025.html",
    dir: "IEEE S&P",
    tag: "venue/sp",
  },
  "USENIX Security": {
    query: "toc:db/conf/uss/uss2025.bht:",
    page: "https://dblp.org/db/conf/uss/uss2025.html",
    dir: "USENIX Security",
    tag: "venue/usenix-security",
  },
  NDSS: {
    query: "toc:db/conf/ndss/ndss2025.bht:",
    page: "https://dblp.org/db/conf/ndss/ndss2025.html",
    dir: "NDSS",
    tag: "venue/ndss",
  },
}

const args = parseArgs(process.argv.slice(2))
const selectedVenues = args.venues.length
  ? args.venues
  : Object.keys(venues)

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  for (const venue of selectedVenues) {
    if (!venues[venue]) {
      throw new Error(`Unknown venue: ${venue}`)
    }
  }

  await mkdir(path.join(root, "data"), { recursive: true })
  await mkdir(path.join(root, "content", "papers", String(year)), { recursive: true })

  const allPapers = []
  for (const venue of selectedVenues) {
    console.log(`Fetching ${venue} ${year} from DBLP`)
    const papers = await fetchVenue(venue)
    console.log(`  ${papers.length} records`)
    allPapers.push(...papers)
  }

  allPapers.sort((a, b) => {
    const venueCompare = a.venue.localeCompare(b.venue)
    if (venueCompare !== 0) return venueCompare
    return a.title.localeCompare(b.title)
  })

  if (args.resolvePdfs) {
    console.log("Resolving open PDF links")
    await mapLimit(allPapers, args.concurrency, async (paper, index) => {
      if (args.limit && index >= args.limit) return
      paper.pdf = await resolvePdf(paper)
      if (args.downloadPdfs && paper.pdf.url) {
        paper.pdf.localPath = await downloadPdf(paper, paper.pdf.url)
        paper.pdf.status = "downloaded"
      }
    })
  } else {
    for (const paper of allPapers) {
      paper.pdf = directPdfFromRecord(paper) ?? {
        status: "not_checked",
        url: "",
        source: "",
      }
    }
  }

  await writeDataFiles(allPapers)
  await writeMarkdownIndexes(allPapers)
  console.log("Done")
}

function parseArgs(raw) {
  const parsed = {
    venues: [],
    resolvePdfs: false,
    downloadPdfs: false,
    limit: 0,
    concurrency: 3,
  }

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i]
    if (arg === "--resolve-pdfs") {
      parsed.resolvePdfs = true
    } else if (arg === "--download-pdfs") {
      parsed.resolvePdfs = true
      parsed.downloadPdfs = true
    } else if (arg === "--venue") {
      parsed.venues.push(raw[++i])
    } else if (arg === "--venues") {
      parsed.venues.push(...raw[++i].split(",").map((v) => v.trim()).filter(Boolean))
    } else if (arg === "--limit") {
      parsed.limit = Number(raw[++i])
    } else if (arg === "--concurrency") {
      parsed.concurrency = Math.max(1, Number(raw[++i]))
    }
  }

  return parsed
}

async function fetchVenue(venue) {
  try {
    return await fetchViaDblpApi(venue)
  } catch (error) {
    console.warn(`  DBLP API failed for ${venue}; falling back to DBLP HTML: ${error.message}`)
    try {
      return await fetchViaDblpHtml(venue)
    } catch (htmlError) {
      console.warn(`  DBLP HTML failed for ${venue}; falling back to record XML: ${htmlError.message}`)
      return await fetchViaDblpRecordXml(venue)
    }
  }
}

async function fetchViaDblpApi(venue) {
  const config = venues[venue]
  const papers = []
  let offset = 0
  const pageSize = 100

  while (true) {
    const url = new URL("https://dblp.org/search/publ/api")
    url.searchParams.set("q", config.query)
    url.searchParams.set("format", "json")
    url.searchParams.set("h", String(pageSize))
    url.searchParams.set("f", String(offset))

    const data = await fetchJson(url)
    const hits = normalizeArray(data?.result?.hits?.hit)
    if (!hits.length) break

    for (const hit of hits) {
      const info = hit.info ?? {}
      if (String(info.year) !== String(year)) continue
      papers.push(normalizeDblpInfo(venue, info))
    }

    const total = Number(data?.result?.hits?.["@total"] ?? papers.length)
    offset += hits.length
    if (offset >= total || hits.length < pageSize) break
  }

  return dedupePapers(papers)
}

async function fetchViaDblpRecordXml(venue) {
  const config = venues[venue]
  const html = await fetchText(mirrorDblpUrl(config.page))
  const xmlUrls = [...html.matchAll(/https:\/\/dblp\.org\/rec\/conf\/[^"'<>\s]+\.xml/g)]
    .map((match) => match[0])
    .filter((url) => !/\/2025\.xml$/.test(url))
  const uniqueUrls = [...new Set(xmlUrls)]

  const papers = []
  await mapLimit(uniqueUrls, 1, async (url) => {
    const xml = await fetchText(url)
    const paper = normalizeDblpXml(venue, xml, url)
    if (paper && String(paper.year) === String(year)) {
      papers.push(paper)
    }
  })

  return dedupePapers(papers)
}

async function fetchViaDblpHtml(venue) {
  const config = venues[venue]
  const html = await fetchText(mirrorDblpUrl(config.page))
  const entries = html.split(/<li class="entry inproceedings"/g).slice(1)
  const papers = []

  for (const entry of entries) {
    const block = `<li class="entry inproceedings"${entry.split(/<li class="entry /)[0]}`
    const paper = normalizeDblpHtmlEntry(venue, block)
    if (paper && String(paper.year) === String(year)) {
      papers.push(paper)
    }
  }

  return dedupePapers(papers)
}

function normalizeDblpInfo(venue, info) {
  const authors = normalizeArray(info.authors?.author)
    .map((author) => typeof author === "string" ? author : author.text)
    .filter(Boolean)
  const ee = normalizeArray(info.ee)
  const doi = info.doi ?? doiFromLinks(ee)

  return {
    venue,
    year,
    track: classifyTrack(info.title),
    title: cleanup(info.title),
    authors,
    pages: info.pages ?? "",
    doi: doi ?? "",
    dblpKey: info.key ?? "",
    dblpUrl: info.url ?? `https://dblp.org/rec/${info.key}`,
    ee,
    access: info.access ?? "",
    type: info.type ?? "",
    pdf: { status: "not_checked", url: "", source: "" },
  }
}

function normalizeDblpXml(venue, xml, sourceUrl) {
  const key = attr(xml, "key") ?? sourceUrl.replace(/^.*\/rec\//, "").replace(/\.xml$/, "")
  const title = tag(xml, "title")
  const paperYear = tag(xml, "year")
  const booktitle = tag(xml, "booktitle")
  if (!title || paperYear !== String(year)) return null
  if (!booktitle) return null

  const ee = tags(xml, "ee").map((item) => item.text)
  const doi = tag(xml, "doi") ?? doiFromLinks(ee)

  return {
    venue,
    year,
    track: classifyTrack(title),
    title: cleanup(title),
    authors: tags(xml, "author").map((item) => cleanup(item.text)),
    pages: tag(xml, "pages") ?? "",
    doi: doi ?? "",
    dblpKey: key,
    dblpUrl: `https://dblp.org/rec/${key}`,
    ee,
    access: ee.some((url) => /ndss-symposium\.org|usenix\.org|arxiv\.org|eprint\.iacr\.org/i.test(url))
      ? "open"
      : "",
    type: "Conference and Workshop Papers",
    pdf: { status: "not_checked", url: "", source: "" },
  }
}

function normalizeDblpHtmlEntry(venue, html) {
  const key = decodeHtml(html.match(/id="([^"]+)"/i)?.[1] ?? "")
  const title = cleanup(html.match(/<span class="title" itemprop="name">([\s\S]*?)<\/span>/i)?.[1] ?? "")
  const paperYear = html.match(/<meta itemprop="datePublished" content="([^"]+)"/i)?.[1]
    ?? cleanup(html.match(/<span itemprop="datePublished">([\s\S]*?)<\/span>/i)?.[1] ?? "")
  if (!key || !title || paperYear !== String(year)) return null

  const cite = html.match(/<cite[\s\S]*?<\/cite>/i)?.[0] ?? html
  const authors = [...cite.matchAll(/<span itemprop="name"(?: title="[^"]*")?>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanup(match[1]))
    .filter((name) => name && name !== title)
  const pages = cleanup(html.match(/<span itemprop="pagination">([\s\S]*?)<\/span>/i)?.[1] ?? "")
  const doi = decodeURIComponent(
    html.match(/https:\/\/doi\.org\/([^"'<>\s]+)/i)?.[1] ?? "",
  )
  const ee = [...html.matchAll(/<li class="ee"><a href="([^"]+)"/gi)]
    .map((match) => decodeHtml(match[1]).replace("https://dblp.uni-trier.de", "https://dblp.org"))

  return {
    venue,
    year,
    track: classifyTrack(title),
    title,
    authors,
    pages,
    doi,
    dblpKey: key,
    dblpUrl: `https://dblp.org/rec/${key}`,
    ee,
    access: ee.some((url) => /ndss-symposium\.org|usenix\.org|arxiv\.org|eprint\.iacr\.org/i.test(url))
      ? "open"
      : "",
    type: "Conference and Workshop Papers",
    pdf: { status: "not_checked", url: "", source: "" },
  }
}

async function resolvePdf(paper) {
  const direct = directPdfFromRecord(paper)
  if (direct) return direct

  const officialPages = paper.ee.filter((url) =>
    /usenix\.org\/conference\/usenixsecurity25\/presentation|ndss-symposium\.org\/ndss-paper/i.test(url),
  )

  for (const pageUrl of officialPages) {
    try {
      const html = await fetchText(pageUrl)
      const pdfs = extractPdfLinks(html, pageUrl)
      const chosen = choosePdf(paper, pdfs)
      if (chosen) {
        return {
          status: "open_pdf_found",
          url: chosen,
          source: sourceName(chosen),
        }
      }
    } catch (error) {
      return {
        status: "check_failed",
        url: "",
        source: error.message,
      }
    }
  }

  if (paper.doi && process.env.UNPAYWALL_EMAIL) {
    const unpaywall = await resolveViaUnpaywall(paper.doi)
    if (unpaywall) return unpaywall
  }

  if (paper.doi) {
    const openalex = await resolveViaOpenAlex(paper.doi)
    if (openalex) return openalex
  }

  return {
    status: "not_found",
    url: "",
    source: "",
  }
}

function directPdfFromRecord(paper) {
  const pdf = paper.ee.find((url) => /\.pdf(?:$|[?#])/i.test(url))
  if (!pdf) return null
  return {
    status: "open_pdf_found",
    url: pdf,
    source: sourceName(pdf),
  }
}

async function resolveViaUnpaywall(doi) {
  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`)
  url.searchParams.set("email", process.env.UNPAYWALL_EMAIL)
  try {
    const data = await fetchJson(url)
    const pdf = data?.best_oa_location?.url_for_pdf
    if (!pdf) return null
    return {
      status: "open_pdf_found",
      url: pdf,
      source: "unpaywall",
    }
  } catch {
    return null
  }
}

async function resolveViaOpenAlex(doi) {
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`
  try {
    const data = await fetchJson(url)
    const pdf = data?.best_oa_location?.pdf_url
      ?? normalizeArray(data?.locations).find((location) => location?.pdf_url)?.pdf_url
    if (!pdf) return null
    return {
      status: "open_pdf_found",
      url: pdf,
      source: "openalex",
    }
  } catch {
    return null
  }
}

async function downloadPdf(paper, pdfUrl) {
  const safeVenue = venues[paper.venue].dir
  const fileName = `${safeSlug(paper.title)}.pdf`
  const relativePath = path.join("local-library", "pdfs", String(year), safeVenue, fileName)
  const fullPath = path.join(root, relativePath)
  await mkdir(path.dirname(fullPath), { recursive: true })

  if (!existsSync(fullPath)) {
    const response = await fetch(pdfUrl, {
      headers: {
        "User-Agent": "rob-quartz-research-pdf-collector/1.0",
      },
    })
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${pdfUrl}: HTTP ${response.status}`)
    }
    await pipeline(response.body, createWriteStream(fullPath))
  }

  return relativePath.replaceAll(path.sep, "/")
}

function extractPdfLinks(html, baseUrl) {
  const hrefs = [...html.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)]
    .map((match) => new URL(decodeHtml(match[1]), baseUrl).toString())
  return [...new Set(hrefs)]
}

function choosePdf(paper, pdfs) {
  if (!pdfs.length) return ""
  const lowerTitle = safeSlug(paper.title)
  const preferred = pdfs.find((url) =>
    /paper\.pdf$/i.test(url)
    || (/usenixsecurity25-/i.test(url) && !/appendix|slides|prepub|poster/i.test(url)),
  )
  if (preferred) return preferred
  const titleMatch = pdfs.find((url) => safeSlug(url).includes(lowerTitle.slice(0, 24)))
  if (titleMatch) return titleMatch
  return pdfs.find((url) => !/appendix|slides|prepub|poster/i.test(url)) ?? pdfs[0]
}

async function writeDataFiles(papers) {
  const jsonPath = path.join(root, "data", "papers-2025-security.json")
  const csvPath = path.join(root, "data", "papers-2025-security.csv")
  await writeFile(jsonPath, `${JSON.stringify(papers, null, 2)}\n`, "utf8")

  const header = [
    "venue",
    "year",
    "track",
    "title",
    "authors",
    "pages",
    "doi",
    "dblp_url",
    "official_url",
    "access",
    "pdf_status",
    "pdf_url",
    "pdf_source",
    "local_pdf",
  ]
  const rows = papers.map((paper) => [
    paper.venue,
    paper.year,
    paper.track,
    paper.title,
    paper.authors.join("; "),
    paper.pages,
    paper.doi,
    paper.dblpUrl,
    paper.ee[0] ?? "",
    paper.access,
    paper.pdf.status,
    paper.pdf.url,
    paper.pdf.source,
    paper.pdf.localPath ?? "",
  ])
  await writeFile(csvPath, [header, ...rows].map(csvLine).join("\n") + "\n", "utf8")
}

async function writeMarkdownIndexes(papers) {
  const byVenue = groupBy(papers, (paper) => paper.venue)
  const yearDir = path.join(root, "content", "papers", String(year))
  await mkdir(yearDir, { recursive: true })

  const summaryRows = Object.keys(venues).map((venue) => {
    const items = byVenue.get(venue) ?? []
    const found = items.filter((paper) => paper.pdf.url).length
    const downloaded = items.filter((paper) => paper.pdf.status === "downloaded").length
    return `| [[${venue} ${year}|${venue}]] | ${items.length} | ${found} | ${downloaded} |`
  })

  await writeFile(
    path.join(yearDir, "index.md"),
    `---\ntitle: ${year} 安全四大会论文索引\ntags:\n  - paper/index\n  - security\n---\n\n# ${year} 安全四大会论文索引\n\n数据来源：DBLP；PDF 链接仅记录明确开放访问来源，下载文件保存在本地 \`local-library/\`，不会发布到网站。\n\n| 会议 | 论文条目 | 找到开放 PDF | 已下载 PDF |\n| --- | ---: | ---: | ---: |\n${summaryRows.join("\n")}\n\n## 数据文件\n\n- \`data/papers-2025-security.csv\`\n- \`data/papers-2025-security.json\`\n\n## 下一步\n\n1. 优先处理开放 PDF 未找到的 CCS 和 IEEE S&P 论文。\n2. 对重点论文使用 [[论文笔记模板]] 建立单独笔记。\n3. 对有代码或 artifact 的论文建立 [[experiments/index|实验复现]] 页面。\n`,
    "utf8",
  )

  for (const [venue, items] of byVenue.entries()) {
    const dir = path.join(yearDir, venues[venue].dir)
    await mkdir(dir, { recursive: true })
    const rows = items.map((paper, index) => markdownPaperRow(index + 1, paper))
    await writeFile(
      path.join(dir, "index.md"),
      `---\ntitle: ${venue} ${year}\nvenue: ${venue}\nyear: ${year}\ntags:\n  - paper/index\n  - ${venues[venue].tag}\n---\n\n# ${venue} ${year}\n\n| # | 标题 | 作者 | 类型 | 页码 | DBLP/DOI | PDF 状态 | PDF |\n| ---: | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
      "utf8",
    )
  }
}

function markdownPaperRow(index, paper) {
  const title = `[${escapeMd(paper.title)}](${paper.dblpUrl})`
  const authors = escapeMd(shortAuthors(paper.authors))
  const doi = paper.doi
    ? `[DOI](https://doi.org/${paper.doi}) / [DBLP](${paper.dblpUrl})`
    : `[DBLP](${paper.dblpUrl})`
  const pdf = paper.pdf.url ? `[PDF](${paper.pdf.url})` : "-"
  const status = pdfStatusLabel(paper.pdf.status)
  return `| ${index} | ${title} | ${authors} | ${paper.track} | ${escapeMd(paper.pages || "-")} | ${doi} | ${status} | ${pdf} |`
}

function classifyTrack(title = "") {
  const text = decodeHtml(title)
  if (/^poster:/i.test(text)) return "poster"
  if (/^demo:/i.test(text)) return "demo"
  if (/workshop|symposium|competition|tutorial|doctoral/i.test(text)) return "workshop"
  if (/^keynote|^invited/i.test(text)) return "invited"
  return "main"
}

function pdfStatusLabel(status) {
  return {
    downloaded: "已下载",
    open_pdf_found: "找到开放 PDF",
    not_checked: "未检查",
    not_found: "未找到",
    check_failed: "检查失败",
  }[status] ?? status
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return await response.json()
}

async function fetchText(url) {
  const response = await fetchWithRetry(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return await response.text()
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "rob-quartz-research-metadata-collector/1.0" },
      })
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        return response
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`)
    } catch (error) {
      lastError = error
    }
    await sleep(1000 * attempt * attempt)
  }
  throw lastError
}

function mirrorDblpUrl(url) {
  return String(url).replace("https://dblp.org/", "https://dblp.uni-trier.de/")
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mapLimit(items, limit, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

function normalizeArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function groupBy(items, keyFn) {
  const groups = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

function dedupePapers(papers) {
  const seen = new Set()
  const deduped = []
  for (const paper of papers) {
    const key = paper.dblpKey || `${paper.venue}:${paper.title}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(paper)
  }
  return deduped
}

function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, "gi"))]
    .map((match) => ({
      attrs: match[1],
      text: cleanup(match[2]),
    }))
}

function tag(xml, name) {
  return tags(xml, name)[0]?.text ?? ""
}

function attr(xml, name) {
  const match = xml.match(new RegExp(`\\s${name}="([^"]+)"`, "i"))
  return match?.[1] ?? ""
}

function cleanup(value = "") {
  return decodeHtml(String(value).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
}

function decodeHtml(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function doiFromLinks(links) {
  const doiUrl = links.find((url) => /doi\.org\//i.test(url))
  if (!doiUrl) return ""
  return decodeURIComponent(doiUrl.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""))
}

function sourceName(url) {
  if (/usenix\.org/i.test(url)) return "usenix"
  if (/ndss-symposium\.org/i.test(url)) return "ndss"
  if (/openalex/i.test(url)) return "openalex"
  if (/arxiv\.org/i.test(url)) return "arxiv"
  return new URL(url).hostname.replace(/^www\./, "")
}

function safeSlug(value) {
  return cleanup(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
}

function shortAuthors(authors) {
  if (!authors.length) return "-"
  if (authors.length <= 3) return authors.join(", ")
  return `${authors.slice(0, 3).join(", ")} 等`
}

function escapeMd(value = "") {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
}

function csvLine(values) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")
}
