import { tool } from "ai";
import { z } from "zod/v3";

/**
 * Web search tool using Teracrawl SERP API.
 *
 * This tool performs web search queries without scraping content, returning
 * only search results with URLs, titles, and descriptions. It's useful for
 * quick lookups and finding relevant URLs before deciding to scrape specific pages.
 *
 * PREREQUISITES:
 * - Teracrawl service must be running (default: http://localhost:8085)
 * - Set TERACRAWL_API_URL environment variable if using a different endpoint
 * - SERP service must be configured and running (required for search functionality)
 *
 * USAGE:
 * The AI can call this tool for quick web searches:
 * - "Search for articles about React hooks"
 * - "Find URLs about machine learning best practices"
 *
 * The tool returns search results without full page content, making it faster
 * than searchAndCrawlWeb for quick lookups.
 */
export const searchWeb = tool({
  description:
    "Search the web and return results with URLs, titles, and descriptions (no page content). Use this for quick lookups when you only need to find relevant URLs or get brief summaries. Faster than searchAndCrawlWeb since it doesn't scrape full page content. Use crawlWeb to scrape specific URLs if you need full content.",

  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("The search query to find results for"),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe("Number of results to return (default: 5, max: 20)"),
  }),

  execute: async ({ query, count = 5 }) => {
    // Get Teracrawl API URL from environment (defaults to localhost:8085)
    const teracrawlApiUrl =
      process.env.TERACRAWL_API_URL?.trim() || "http://localhost:8085";
    const serpEndpoint = `${teracrawlApiUrl}/serp/search`;

    try {
      // Call Teracrawl API
      const response = await fetch(serpEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, count }),
        // Set reasonable timeout (15 seconds for search only)
        signal: AbortSignal.timeout(15000),
      });

      // Handle HTTP errors
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          errorData.message || errorData.error || `HTTP ${response.status}`;

        // Provide helpful error messages based on status code
        if (response.status === 400) {
          if (errorData.error === "q_required") {
            return {
              success: false,
              query,
              results: [],
              error: "Search query is required. Please provide a valid query.",
            };
          }
        }

        if (response.status === 500 && errorData.error === "serp_failed") {
          return {
            success: false,
            query,
            results: [],
            error: `Search failed: ${errorMessage}. Check that the SERP service is configured and running.`,
          };
        }

        return {
          success: false,
          query,
          results: [],
          error: `Teracrawl API error: ${errorMessage}`,
        };
      }

      // Parse successful response
      const data = await response.json();

      // Teracrawl response format:
      // { results: Array<{ url?, title?, description? }> }
      const results = (data.results || []).map((result: {
        url?: string;
        title?: string;
        description?: string;
      }, index: number) => ({
        position: index + 1,
        url: result.url || "",
        title: result.title || "",
        description: result.description || "",
      }));

      return {
        success: true,
        query,
        results,
        totalResults: results.length,
      };
    } catch (error) {
      // Handle network errors, timeouts, etc.
      if (error instanceof Error) {
        // Check if it's a timeout
        if (error.name === "TimeoutError" || error.message.includes("timeout")) {
          return {
            success: false,
            query,
            results: [],
            error:
              "Request timed out. The search operation may be taking too long or the Teracrawl service may be unavailable.",
          };
        }

        // Check if it's a connection error
        if (
          error.message.includes("fetch") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("network")
        ) {
          return {
            success: false,
            query,
            results: [],
            error: `Cannot connect to Teracrawl service at ${teracrawlApiUrl}. Make sure Teracrawl is running, SERP service is configured, and TERACRAWL_API_URL is set correctly.`,
          };
        }

        // Generic error
        return {
          success: false,
          query,
          results: [],
          error: `Error during search: ${error.message}`,
        };
      }

      // Unknown error type
      return {
        success: false,
        query,
        results: [],
        error: "An unknown error occurred during search",
      };
    }
  },
});
