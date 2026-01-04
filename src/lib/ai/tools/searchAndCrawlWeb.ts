import { tool } from "ai";
import { z } from "zod/v3";

/**
 * Web search and crawl tool using Teracrawl API.
 *
 * This tool performs a Google search and scrapes the top results in parallel,
 * returning clean Markdown content for each result. It enables comprehensive
 * research by combining search and content extraction in a single operation.
 *
 * PREREQUISITES:
 * - Teracrawl service must be running (default: http://localhost:8085)
 * - Set TERACRAWL_API_URL environment variable if using a different endpoint
 * - SERP service must be configured and running (required for search functionality)
 * - Teracrawl service requires BROWSER_API_KEY (configured in Teracrawl, not here)
 *
 * USAGE:
 * The AI can call this tool to search and scrape multiple sources:
 * - "Search for information about TypeScript best practices and scrape the results"
 * - "Find and crawl the top 5 articles about web scraping"
 *
 * The tool returns an array of results with Markdown content optimized for LLM consumption.
 */
export const searchAndCrawlWeb = tool({
  description:
    "Search Google and scrape the top results in parallel. Performs a web search and converts each result page to clean Markdown format. Returns multiple results with full content. Use this when you need to research a topic comprehensively by gathering content from multiple sources in one operation.",

  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("The search query to find and scrape results for"),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(3)
      .describe("Number of results to scrape (default: 3, max: 20)"),
  }),

  execute: async ({ query, count = 3 }) => {
    // Get Teracrawl API URL from environment (defaults to localhost:8085)
    const teracrawlApiUrl =
      process.env.TERACRAWL_API_URL?.trim() || "http://localhost:8085";
    const crawlEndpoint = `${teracrawlApiUrl}/crawl`;

    try {
      // Call Teracrawl API
      const response = await fetch(crawlEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, count }),
        // Set reasonable timeout (60 seconds for multiple pages)
        signal: AbortSignal.timeout(60000),
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

        if (response.status === 500 && errorData.error === "crawl_failed") {
          return {
            success: false,
            query,
            results: [],
            error: `Search and crawl failed: ${errorMessage}. Check that the SERP service is configured and running.`,
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
      // { query: string, results: Array<{ url, title, markdown, status: "success" | "empty" | "error", error? }> }
      const results = (data.results || []).map((result: {
        url: string;
        title: string;
        markdown: string;
        status: "success" | "empty" | "error";
        error?: string;
      }) => ({
        url: result.url || "",
        title: result.title || "",
        markdown: result.markdown || "",
        status: result.status || "error",
        error: result.error,
        success: result.status === "success",
      }));

      return {
        success: true,
        query: data.query || query,
        results,
        totalResults: results.length,
        successfulResults: results.filter(
          (r: { status: string }) => r.status === "success"
        ).length,
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
              "Request timed out. The search and crawl operation may be taking too long or the Teracrawl service may be unavailable.",
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
          error: `Error during search and crawl: ${error.message}`,
        };
      }

      // Unknown error type
      return {
        success: false,
        query,
        results: [],
        error: "An unknown error occurred during search and crawl",
      };
    }
  },
});
