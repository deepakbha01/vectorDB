/**
 * Format-agnostic intermediate representation every exportable deliverable is
 * converted into once, then rendered by a single PDF renderer and a single
 * DOCX renderer - so adding a new report type never means writing new PDF/DOCX
 * layout code, and fixing a rendering bug fixes it for every report at once.
 */
export interface ReportField {
  label: string;
  value: string;
}

export interface ReportTable {
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface ReportList {
  title?: string;
  items: string[];
}

export interface ReportSection {
  heading: string;
  paragraphs?: string[];
  fields?: ReportField[];
  tables?: ReportTable[];
  lists?: ReportList[];
}

export interface ReportDocument {
  title: string;
  subtitle?: string;
  generatedAt: string;
  sections: ReportSection[];
}
