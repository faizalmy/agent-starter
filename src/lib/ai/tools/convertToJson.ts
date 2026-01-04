import { tool } from "ai";
import { z } from "zod/v3";

/**
 * JSON Conversion Tool
 *
 * Converts various data formats into JSON strings with intelligent handling of
 * edge cases including circular references, special JavaScript types, and formatting options.
 *
 * The tool accepts abstract input with minimal type constraints, allowing the AI
 * to determine the best conversion approach based on the user's request.
 *
 * FEATURES:
 * - Handles circular references using WeakSet
 * - Converts special types (Date, BigInt, Map, Set, RegExp, undefined)
 * - Supports pretty printing with customizable indentation
 * - Validates and formats existing JSON strings
 * - Returns structured response with metadata
 *
 * USAGE:
 * The AI can call this tool to convert data to JSON:
 * - "Convert this object to JSON"
 * - "Format this JSON with 2-space indentation"
 * - "Convert this array to a JSON string"
 */
export const convertToJson = tool({
  description:
    "Convert various data formats (objects, arrays, strings) into JSON strings. Handles circular references, special JavaScript types (Date, BigInt, Map, Set), and supports pretty printing. Can also validate and format existing JSON strings.",

  inputSchema: z.object({
    data: z
      .any()
      .describe(
        "The data to convert to JSON. Can be an object, array, string (JSON to validate/format), or any serializable data structure."
      ),
    pretty: z
      .boolean()
      .optional()
      .describe(
        "Whether to include a pretty-printed (formatted) version in the response. Default: false"
      ),
    indent: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Number of spaces to use for indentation when pretty printing. Default: 2"
      ),
  }),

  execute: async ({ data, pretty = false, indent = 2 }) => {
    try {
      // Handle string input (JSON validation/formatting)
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          const minified = JSON.stringify(parsed);
          const formatted = pretty
            ? JSON.stringify(parsed, null, indent)
            : undefined;

          return {
            success: true,
            json: minified,
            formatted: formatted,
            size: Buffer.byteLength(minified, "utf8"),
          };
        } catch (parseError) {
          return {
            success: false,
            json: "",
            error: `Invalid JSON string: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }`,
          };
        }
      }

      // Create WeakSet to track circular references
      const seen = new WeakSet();

      /**
       * Custom replacer function to handle special types and circular references
       */
      const replacer = (key: string, value: unknown): unknown => {
        // Handle circular references
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }

        // Handle Date objects
        if (value instanceof Date) {
          return value.toISOString();
        }

        // Handle BigInt
        if (typeof value === "bigint") {
          return value.toString();
        }

        // Handle undefined (convert to null for JSON compatibility)
        if (value === undefined) {
          return null;
        }

        // Handle Map objects
        if (value instanceof Map) {
          return Array.from(value.entries());
        }

        // Handle Set objects
        if (value instanceof Set) {
          return Array.from(value);
        }

        // Handle RegExp objects
        if (value instanceof RegExp) {
          return value.toString();
        }

        return value;
      };

      // Convert to JSON with custom replacer
      const minified = JSON.stringify(data, replacer);
      const formatted = pretty ? JSON.stringify(data, replacer, indent) : undefined;

      return {
        success: true,
        json: minified,
        formatted: formatted,
        size: Buffer.byteLength(minified, "utf8"),
      };
    } catch (error) {
      return {
        success: false,
        json: "",
        error:
          error instanceof Error
            ? error.message
            : "An unknown error occurred during JSON conversion",
      };
    }
  },
});
