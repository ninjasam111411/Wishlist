// api/scrape.js
//
// Vercel serverless function. Given a product link, fetches that page on
// the server (not in the browser, which would get blocked by most stores'
// CORS rules) and pulls a title / description / image out of its Open
// Graph or basic meta tags, so a wishlist item can show a photo.
//
// This file has no npm dependencies on purpose (no package.json in this
// project) -- it parses the handful of meta tags it needs with small
// regular expressions instead of pulling in an HTML parser library.
//
// Expects:  POST { url: string }
// Returns:  { title, description, image }  (any of these can be null)

function extractMeta(html, key) {
  // <meta property="og:image" content="..."> and the reverse attribute
  // order, plus the "name=" variant some sites use instead of "property=".
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${key}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${key}["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1];
  }
  return null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing 'url' in request body" });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    res.status(400).json({ error: "That doesn't look like a valid http(s) URL" });
    return;
  }

  try {
    const pageRes = await fetch(parsedUrl.toString(), {
      redirect: "follow",
      headers: {
        // A plain server-side fetch with no user-agent gets blocked by a
        // lot of stores, so we identify ourselves like a normal browser.
        "User-Agent":
          "Mozilla/5.0 (compatible; WishlistLinkPreview/1.0; +https://wishlist-code.github.io/Wishlist/)",
      },
    });

    if (!pageRes.ok) {
      res.status(200).json({ title: null, description: null, image: null });
      return;
    }

    const html = await pageRes.text();

    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title =
      decodeEntities(extractMeta(html, "og:title")) ||
      decodeEntities(titleTagMatch ? titleTagMatch[1].trim() : null);

    const description =
      decodeEntities(extractMeta(html, "og:description")) ||
      decodeEntities(extractMeta(html, "description"));

    let image = extractMeta(html, "og:image");
    if (image && !/^https?:\/\//i.test(image)) {
      // Some sites give a path like "/images/foo.jpg" -- resolve it
      // against the page's own URL so it's a real, usable image URL.
      try {
        image = new URL(image, parsedUrl).toString();
      } catch {
        image = null;
      }
    }

    res.status(200).json({ title, description, image: image || null });
  } catch (err) {
    // A store that blocks scrapers, a bad link, a timeout, etc. -- the
    // item can still be added without a photo, so this fails quietly.
    res.status(200).json({ title: null, description: null, image: null });
  }
}

