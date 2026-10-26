import { SIGNED_OUT_POSTS_QUERY, SIGNED_OUT_TRAY_QUERY, relayOperationId } from "@turbodl/shared";
import { isInstagramScriptHost } from "./partition";

/** The queries a signed-out profile page is read on with. */
const QUERIES = [SIGNED_OUT_POSTS_QUERY, SIGNED_OUT_TRAY_QUERY];
/** Instagram's web app, as its pages name it to the API. */
const APP_ID = "936619743392459";

/** Query ids found in the scripts Instagram's pages load, kept for the app's run. */
export class OperationIds {
  private readonly ids = new Map<string, string>();

  /** Scans a script for the signed-out queries' ids; a script that defines none leaves the known ones as they are. */
  note(script: string): void {
    for (const name of QUERIES) {
      // most scripts define neither: a plain search first, the pattern only where the name is
      if (!script.includes(`"${name}_instagramRelayOperation"`)) continue;
      const id = relayOperationId(script, name);
      if (id) this.ids.set(name, id);
    }
  }

  get(name: string): string | undefined {
    return this.ids.get(name);
  }

  /** An id Instagram no longer answers to; given `docId`, only while that is still the one known (no newer one noted since). */
  forget(name: string, docId?: string): void {
    if (docId === undefined || this.ids.get(name) === docId) this.ids.delete(name);
  }

  /** Some signed-out query's id is still unknown. */
  missing(): boolean {
    return QUERIES.some((name) => !this.ids.has(name));
  }

  /** An answer worth scanning for the ids: a script from Instagram's CDN, while an id is still unknown. */
  wants(address: string, mimeType: string): boolean {
    return this.missing() && /javascript/i.test(mimeType) && isInstagramScriptHost(address);
  }
}

/** The ids every hidden page notes and every profile feed sends. */
export const operationIds = new OperationIds();

/** Why a profile seen signed out stays at the pages it has: its query is no longer answered. */
export const STALE_SIGNED_OUT = "Instagram changed its signed-out profile page; TurboDL couldn't read further posts.";
/** Why a signed-out highlights tray stays at the highlights it has: its query is no longer answered. */
export const STALE_SIGNED_OUT_TRAY = "Instagram changed its signed-out profile page; TurboDL couldn't read further highlights.";
/** A signed-out query that failed on the way or took too long: the query's id is kept. */
export const NO_ANSWER = "Instagram didn't answer.";
/** A signed-out page without the lsd token its queries are sent with. */
export const NO_LSD = "Instagram's signed-out profile page didn't give TurboDL the token its queries need.";

/**
 * The page-side script that sends a signed-out query (`POST /api/graphql`, a Relay form, the page's lsd and CSRF
 * cookie) with the page's credentials, and evaluates to `{ status, text }`. Everything taken from Instagram goes in as
 * JSON literals, never as code; only the CSRF cookie is read in the page.
 */
export function signedOutQueryScript(o: { docId: string; lsd: string; name: string; variables: Record<string, unknown> }): string {
  const form = new URLSearchParams({
    doc_id: o.docId,
    variables: JSON.stringify(o.variables),
    lsd: o.lsd,
    fb_api_req_friendly_name: o.name,
    fb_api_caller_class: "RelayModern",
    server_timestamps: "true",
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-FB-LSD": o.lsd, "X-IG-App-ID": APP_ID, "X-FB-Friendly-Name": o.name };
  return `(() => {
  const csrf = /(?:^|;\\s*)csrftoken=([^;]*)/.exec(document.cookie);
  const headers = { ...${JSON.stringify(headers)}, "X-CSRFToken": csrf ? csrf[1] : "" };
  return fetch("/api/graphql", { method: "POST", headers, body: ${JSON.stringify(form.toString())}, credentials: "include" }).then(async (r) => ({ status: r.status, text: await r.text() }));
})()`;
}
