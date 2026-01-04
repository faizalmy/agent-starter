import { tool } from "ai";
import { z } from "zod/v3";

/**
 * CSV Generation Tool
 *
 * Converts various data formats into CSV (Comma-Separated Values) strings with
 * intelligent handling of tabular data, proper CSV escaping, and formatting options.
 *
 * The tool accepts abstract input with minimal type constraints, allowing the AI
 * to determine the best conversion approach based on the user's request.
 *
 * FEATURES:
 * - Converts array of objects (with automatic header generation from keys)
 * - Converts array of arrays (with optional header row)
 * - Handles CSV field escaping (commas, quotes, newlines)
 * - Converts special types (Date, BigInt, undefined, nested objects)
 * - Supports customizable delimiters (comma, semicolon, tab)
 * - Custom header names and header inclusion control
 * - Returns structured response with metadata
 *
 * USAGE:
 * The AI can call this tool to convert data to CSV:
 * - "Convert this array of objects to CSV"
 * - "Generate a CSV file from this data"
 * - "Export this data as CSV with semicolon delimiter"
 */
export const generateCsv = tool({
  description:
    "Convert tabular data (array of objects, array of arrays) into CSV format. Automatically generates headers from object keys, handles CSV escaping for special characters, and supports custom delimiters and formatting options.",

  inputSchema: z.object({
    data: z
      .any()
      .describe(
        "The data to convert to CSV. Can be an array of objects (keys become headers) or an array of arrays (tabular data)."
      ),
    delimiter: z
      .string()
      .length(1)
      .optional()
      .describe(
        "CSV delimiter character. Default: comma (','). Common options: ',', ';', '\t'"
      ),
    includeHeaders: z
      .boolean()
      .optional()
      .describe(
        "Whether to include a header row in the CSV output. Default: true. For array of objects, headers are generated from keys. For array of arrays, first array becomes header if true."
      ),
    headers: z
      .array(z.string())
      .optional()
      .describe(
        "Custom header names to use instead of object keys. Must match the number of columns. If provided, overrides automatic header generation."
      ),
  }),

  execute: async ({
    data,
    delimiter = ",",
    includeHeaders = true,
    headers,
  }) => {
    try {
      // Validate that data is an array
      if (!Array.isArray(data)) {
        return {
          success: false,
          csv: "",
          rowCount: 0,
          columnCount: 0,
          headers: [],
          error: "Input data must be an array (array of objects or array of arrays)",
        };
      }

      // Handle empty array
      if (data.length === 0) {
        if (includeHeaders && headers && headers.length > 0) {
          return {
            success: true,
            csv: headers.join(delimiter) + "\n",
            rowCount: 0,
            columnCount: headers.length,
            headers: headers,
            size: Buffer.byteLength(headers.join(delimiter) + "\n", "utf8"),
          };
        }
        return {
          success: true,
          csv: "",
          rowCount: 0,
          columnCount: 0,
          headers: [],
          size: 0,
        };
      }

      /**
       * Escape CSV field value
       * - Wrap fields containing delimiter, quotes, or newlines in double quotes
       * - Escape internal double quotes by doubling them
       */
      const escapeCsvField = (value: unknown): string => {
        // Convert value to string, handling special types
        let stringValue: string;

        if (value === null || value === undefined) {
          stringValue = "";
        } else if (value instanceof Date) {
          stringValue = value.toISOString();
        } else if (typeof value === "bigint") {
          stringValue = value.toString();
        } else if (typeof value === "object") {
          // Convert nested objects/arrays to JSON string
          stringValue = JSON.stringify(value);
        } else {
          stringValue = String(value);
        }

        // Check if field needs quoting (contains delimiter, quotes, or newlines)
        if (
          stringValue.includes(delimiter) ||
          stringValue.includes('"') ||
          stringValue.includes("\n") ||
          stringValue.includes("\r")
        ) {
          // Escape internal quotes by doubling them, then wrap in quotes
          return `"${stringValue.replace(/"/g, '""')}"`;
        }

        return stringValue;
      };

      // Determine if data is array of objects or array of arrays
      const isArrayOfObjects = data.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));

      let csvRows: string[] = [];
      let columnHeaders: string[] = [];
      let columnCount = 0;

      if (isArrayOfObjects) {
        // Array of objects: extract keys from first object as headers
        const firstObject = data[0] as Record<string, unknown>;

        if (headers && headers.length > 0) {
          // Use custom headers
          columnHeaders = headers;
          columnCount = headers.length;
        } else {
          // Generate headers from object keys
          columnHeaders = Object.keys(firstObject);
          columnCount = columnHeaders.length;
        }

        // Add header row if requested
        if (includeHeaders) {
          csvRows.push(columnHeaders.map(escapeCsvField).join(delimiter));
        }

        // Convert each object to CSV row
        for (const obj of data as Array<Record<string, unknown>>) {
          const row = columnHeaders.map((header) => escapeCsvField(obj[header]));
          csvRows.push(row.join(delimiter));
        }
      } else {
        // Array of arrays: treat as tabular data
        const firstArray = data[0] as unknown[];

        if (!Array.isArray(firstArray)) {
          return {
            success: false,
            csv: "",
            rowCount: 0,
            columnCount: 0,
            headers: [],
            error: "Data must be array of objects or array of arrays",
          };
        }

        columnCount = firstArray.length;

        // Determine headers for array of arrays
        if (headers && headers.length > 0) {
          if (headers.length !== columnCount) {
            return {
              success: false,
              csv: "",
              rowCount: 0,
              columnCount: 0,
              headers: [],
              error: `Custom headers count (${headers.length}) must match column count (${columnCount})`,
            };
          }
          columnHeaders = headers;
        } else if (includeHeaders) {
          // Use first array as headers if includeHeaders is true
          columnHeaders = firstArray.map((val) => String(val ?? ""));
        } else {
          // No headers, use empty array
          columnHeaders = [];
        }

        // Add header row if requested
        if (includeHeaders && columnHeaders.length > 0) {
          csvRows.push(columnHeaders.map(escapeCsvField).join(delimiter));
        }

        // Determine start index for data rows
        const startIndex = includeHeaders && !headers ? 1 : 0;

        // Convert each array to CSV row
        for (let i = startIndex; i < data.length; i++) {
          const row = data[i] as unknown[];
          if (!Array.isArray(row)) {
            return {
              success: false,
              csv: "",
              rowCount: 0,
              columnCount: 0,
              headers: [],
              error: `Row ${i} is not an array`,
            };
          }

          if (row.length !== columnCount) {
            return {
              success: false,
              csv: "",
              rowCount: 0,
              columnCount: 0,
              headers: [],
              error: `Row ${i} has ${row.length} columns, expected ${columnCount}`,
            };
          }

          csvRows.push(row.map(escapeCsvField).join(delimiter));
        }
      }

      const csvString = csvRows.join("\n");
      const dataRowCount = isArrayOfObjects
        ? data.length
        : includeHeaders && !headers
          ? data.length - 1
          : data.length;

      return {
        success: true,
        csv: csvString,
        rowCount: dataRowCount,
        columnCount: columnCount,
        headers: columnHeaders,
        size: Buffer.byteLength(csvString, "utf8"),
      };
    } catch (error) {
      return {
        success: false,
        csv: "",
        rowCount: 0,
        columnCount: 0,
        headers: [],
        error:
          error instanceof Error
            ? error.message
            : "An unknown error occurred during CSV generation",
      };
    }
  },
});
