const fs = require("node:fs/promises");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const { parse: parseCsv } = require("csv-parse/sync");

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function toBuffer(file) {
  if (Buffer.isBuffer(file?.buffer)) {
    return file.buffer;
  }

  if (typeof file?.arrayBuffer === "function") {
    const arrayBuffer = await file.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  if (typeof file?.path === "string") {
    return fs.readFile(file.path);
  }

  throw new Error("File does not contain a readable buffer");
}

async function toText(file) {
  if (typeof file?.text === "function") {
    return file.text();
  }

  const buffer = await toBuffer(file);
  return buffer.toString("utf8");
}

function getFileInfo(file) {
  return {
    name: file?.name || file?.originalname || "unknown",
    mimeType: file?.type || file?.mimetype || "application/octet-stream",
    size: file?.size || null,
  };
}

async function parseFile(file) {
  const metadata = getFileInfo(file);
  const contentType = metadata.mimeType;

  let parsedType = "text";
  let rawText = "";
  let structured = null;

  if (contentType === "text/plain") {
    rawText = normalizeText(await toText(file));
  } else if (contentType === "text/csv" || contentType === "application/csv") {
    parsedType = "csv";
    const csvText = await toText(file);
    const rows = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    structured = rows;
    rawText = normalizeText(
      rows.map((row) => Object.values(row).join(" | ")).join("\n"),
    );
  } else if (contentType === "application/json") {
    parsedType = "json";
    const jsonText = await toText(file);

    try {
      structured = JSON.parse(jsonText);
    } catch {
      throw new Error("Invalid JSON file");
    }

    rawText = normalizeText(JSON.stringify(structured, null, 2));
  } else if (contentType === "application/pdf") {
    parsedType = "pdf";
    const parser = new PDFParse({ data: await toBuffer(file) });
    const pdfData = await parser.getText();
    await parser.destroy();
    rawText = normalizeText(pdfData.text);
  } else if (
    contentType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    parsedType = "docx";
    const docxData = await mammoth.extractRawText({
      buffer: await toBuffer(file),
    });
    rawText = normalizeText(docxData.value);
  } else {
    throw new Error(`Unsupported file type: ${contentType}`);
  }

  return {
    parsedType,
    rawText,
    structured,
    metadata,
  };
}

module.exports = {
  parseFile,
};
