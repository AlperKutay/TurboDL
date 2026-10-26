import { SIGNED_OUT_POSTS_QUERY, SIGNED_OUT_TRAY_QUERY, relayOperationId } from "@turbodl/shared";

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

  /** An id Instagram no longer answers to. */
  forget(name: string): void {
    this.ids.delete(name);
  }
}

/** The ids every hidden page notes and every profile feed sends. */
export const operationIds = new OperationIds();

/** Why a profile seen signed out stays at the pages it has: its query is no longer answered. */
export const STALE_SIGNED_OUT = "Instagram changed its signed-out profile page; TurboDL couldn't read further posts.";

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
