import { tool } from "ai";
import { z } from "zod/v3";

/**
 * Web crawling tool using Teracrawl API.
 *
 * Teracrawl is a high-performance web crawler optimized for LLMs that converts
 * web pages into clean Markdown format using remote browsers. It handles
 * JavaScript-heavy sites and SPAs effectively.
 *
 * PREREQUISITES:
 * - Teracrawl service must be running (default: http://localhost:8085)
 * - Set TERACRAWL_API_URL environment variable if using a different endpoint
 * - Teracrawl service requires BROWSER_API_KEY (configured in Teracrawl, not here)
 *
 * USAGE:
 * The AI can call this tool to extract content from web pages:
 * - "Crawl https://example.com and summarize the content"
 * - "What's on the homepage of https://news.ycombinator.com?"
 *
 * The tool returns clean Markdown content that's optimized for LLM consumption.
 */
export const crawlWeb = tool({
  description:
    "Crawl a web page and convert it to clean Markdown format. Handles JavaScript-heavy sites and SPAs. Returns the page content, title, and metadata. Use this when you need to extract or analyze content from a specific URL.",

  inputSchema: z.object({
    url: z
      .string()
      .url()
      .describe("The URL to crawl (must be a valid HTTP or HTTPS URL)"),
  }),

  execute: async ({ url }) => {
    // Get Teracrawl API URL from environment (defaults to localhost:8085)
    const teracrawlApiUrl =
      process.env.TERACRAWL_API_URL?.trim() || "http://localhost:8085";
    const scrapeEndpoint = `${teracrawlApiUrl}/scrape`;

    try {
      // Call Teracrawl API
      const response = await fetch(scrapeEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
        // Set reasonable timeout (30 seconds)
        signal: AbortSignal.timeout(30000),
      });

      // Handle HTTP errors
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          errorData.message || errorData.error || `HTTP ${response.status}`;

        // Provide helpful error messages based on status code
        if (response.status === 400) {
          if (errorData.error === "valid_url_required") {
            return {
              success: false,
              url,
              status: "error",
              error: "Invalid URL format. Please provide a valid HTTP or HTTPS URL.",
            };
          }
          if (errorData.error === "pdf_not_supported") {
            return {
              success: false,
              url,
              status: "error",
              error:
                "PDF URLs require DATALAB_API_KEY to be configured in the Teracrawl service.",
            };
          }
        }

        return {
          success: false,
          url,
          status: "error",
          error: `Teracrawl API error: ${errorMessage}`,
        };
      }

      // Parse successful response
      const data = await response.json();

      // Teracrawl response format:
      // { url, title, markdown, status: "success" | "empty" | "error", error? }
      if (data.status === "error" || data.status === "empty") {
        return {
          success: false,
          url: data.url || url,
          title: data.title || undefined,
          content: "",
          contentLength: 0,
          status: data.status,
          error:
            data.error ||
            (data.status === "empty"
              ? "Page content was too short or could not be extracted"
              : "Unknown error occurred while crawling"),
        };
      }

      // Success case
      const markdown = data.markdown || "";
      return {
        success: true,
        url: data.url || url,
        title: data.title || undefined,
        content: markdown,
        contentLength: markdown.length,
        status: "success",
      };
    } catch (error) {
      // Handle network errors, timeouts, etc.
      if (error instanceof Error) {
        // Check if it's a timeout
        if (error.name === "TimeoutError" || error.message.includes("timeout")) {
          return {
            success: false,
            url,
            status: "error",
            error:
              "Request timed out. The page may be taking too long to load or the Teracrawl service may be unavailable.",
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
            url,
            status: "error",
            error: `Cannot connect to Teracrawl service at ${teracrawlApiUrl}. Make sure Teracrawl is running and TERACRAWL_API_URL is configured correctly.`,
          };
        }

        // Generic error
        return {
          success: false,
          url,
          status: "error",
          error: `Error crawling URL: ${error.message}`,
        };
      }

      // Unknown error type
      return {
        success: false,
        url,
        status: "error",
        error: "An unknown error occurred while crawling the URL",
      };
    }
  },
});
