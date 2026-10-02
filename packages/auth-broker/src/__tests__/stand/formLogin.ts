/**
 * Plays the user in an interactive login against a stand server's own login
 * page: follows redirects, keeps cookies, finds the form with a password
 * field, fills it in with every hidden field it carries (UAA's CSRF token,
 * Keycloak's session code), and submits it.
 *
 * Deliberately small: enough for UAA's and Keycloak's stock login pages, which
 * the pinned image versions keep stable. It is a test helper, not a browser.
 */

export interface Credentials {
  username: string;
  password: string;
}

const MAX_HOPS = 20;

export class FormBrowser {
  private readonly cookies = new Map<string, string>();

  /** GET `url` and follow redirects until `stop(url)` or a page is served. */
  async open(
    url: string,
    stop: (next: string) => boolean = () => false,
  ): Promise<{ url: string; html?: string }> {
    return this.follow(url, { method: 'GET' }, stop);
  }

  /**
   * Submit the login form on `page`, then follow redirects until `stop` says
   * the next location is the one the caller wants — typically the client's
   * redirect URI carrying the code — without requesting it.
   */
  async submitLogin(
    page: { url: string; html?: string },
    credentials: Credentials,
    stop: (next: string) => boolean = () => false,
  ): Promise<{ url: string; html?: string }> {
    const form = findPasswordForm(page.html ?? '');
    if (!form) {
      throw new Error(`no login form on ${page.url}`);
    }
    const body = new URLSearchParams(form.hidden);
    body.set(form.userField, credentials.username);
    body.set(form.passwordField, credentials.password);
    return this.follow(
      new URL(form.action, page.url).toString(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      stop,
    );
  }

  /**
   * Accept a consent page ("Do you grant these access privileges?"): submit
   * the form that carries an `accept` button, with its hidden fields.
   */
  async acceptConsent(page: {
    url: string;
    html?: string;
  }): Promise<{ url: string; html?: string }> {
    for (const match of (page.html ?? '').matchAll(
      /<form\b[^>]*>[\s\S]*?<\/form>/gi,
    )) {
      const formHtml = match[0];
      const inputs = [...formHtml.matchAll(/<(?:input|button)\b[^>]*>/gi)].map(
        (m) => m[0],
      );
      const accept = inputs.find((i) => attribute(i, 'name') === 'accept');
      if (!accept) continue;
      const body = new URLSearchParams();
      for (const input of inputs) {
        const name = attribute(input, 'name');
        if (name && attribute(input, 'type') === 'hidden') {
          body.set(name, attribute(input, 'value') ?? '');
        }
      }
      body.set('accept', attribute(accept, 'value') ?? 'Yes');
      const formTag = /<form\b[^>]*>/i.exec(formHtml)?.[0] ?? '';
      return this.follow(
        new URL(attribute(formTag, 'action') ?? '', page.url).toString(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
        () => false,
      );
    }
    throw new Error(`no consent form on ${page.url}`);
  }

  private async follow(
    url: string,
    init: RequestInit,
    stop: (next: string) => boolean,
  ): Promise<{ url: string; html?: string }> {
    let current = url;
    let request = init;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const response = await fetch(current, {
        ...request,
        redirect: 'manual',
        headers: { ...(request.headers ?? {}), Cookie: this.cookieHeader() },
        signal: AbortSignal.timeout(15_000),
      });
      this.remember(response);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        if (stop(next)) return { url: next };
        current = next;
        request = { method: 'GET' };
        continue;
      }
      return { url: current, html: await response.text() };
    }
    throw new Error(`more than ${MAX_HOPS} redirects from ${url}`);
  }

  private remember(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * Log in through the authorization URL and return the redirect URI the server
 * sends the browser back to, with its `code` — not requested, since nothing
 * listens there.
 */
export async function authorizeByForm(
  authorizationUrl: string,
  redirectUri: string,
  credentials: Credentials,
): Promise<URL> {
  const reached = (next: string) => next.startsWith(redirectUri);
  const browser = new FormBrowser();
  const page = await browser.open(authorizationUrl, reached);
  const done =
    page.html === undefined
      ? page
      : await browser.submitLogin(page, credentials, reached);
  if (!reached(done.url)) {
    throw new Error(
      `login did not return to ${redirectUri}; ended at ${done.url}`,
    );
  }
  return new URL(done.url);
}

/**
 * Approve a device authorization the way a user would: open the verification
 * URI (with the user code already in it), log in, and grant access.
 */
export async function approveDevice(
  verificationUriComplete: string,
  credentials: Credentials,
): Promise<void> {
  const browser = new FormBrowser();
  const page = await browser.open(verificationUriComplete);
  const consent = await browser.submitLogin(page, credentials);
  await browser.acceptConsent(consent);
}

/**
 * A SAML login at an identity provider: open the AuthnRequest URL, log in,
 * and take the SAMLResponse from the auto-posting form the IdP answers with —
 * what a browser would post to the assertion consumer service.
 */
export async function samlResponseByForm(
  authnRequestUrl: string,
  credentials: Credentials,
): Promise<{ samlResponse: string; acsUrl: string }> {
  const browser = new FormBrowser();
  const page = await browser.submitLogin(
    await browser.open(authnRequestUrl),
    credentials,
  );
  const html = page.html ?? '';
  const input = [...html.matchAll(/<input\b[^>]*>/gi)]
    .map((m) => m[0])
    .find((i) => attribute(i, 'name') === 'SAMLResponse');
  const samlResponse = input ? attribute(input, 'value') : undefined;
  const formTag = /<form\b[^>]*>/i.exec(html)?.[0] ?? '';
  if (!samlResponse) {
    throw new Error(`no SAMLResponse form on ${page.url}`);
  }
  return { samlResponse, acsUrl: attribute(formTag, 'action') ?? '' };
}

interface LoginForm {
  action: string;
  userField: string;
  passwordField: string;
  hidden: Record<string, string>;
}

const decode = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    'i',
  ).exec(tag);
  return match ? decode(match[2] ?? match[3] ?? '') : undefined;
};

function findPasswordForm(html: string): LoginForm | undefined {
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const formHtml = match[0];
    const inputs = [...formHtml.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
    const password = inputs.find((i) => attribute(i, 'type') === 'password');
    if (!password) continue;
    const hidden: Record<string, string> = {};
    let userField = 'username';
    for (const input of inputs) {
      const type = (attribute(input, 'type') ?? 'text').toLowerCase();
      const name = attribute(input, 'name');
      if (!name) continue;
      if (type === 'hidden') hidden[name] = attribute(input, 'value') ?? '';
      if (
        (type === 'text' || type === 'email') &&
        /user|email|login/i.test(name)
      ) {
        userField = name;
      }
    }
    const formTag = /<form\b[^>]*>/i.exec(formHtml)?.[0] ?? '';
    return {
      action: attribute(formTag, 'action') ?? '',
      userField,
      passwordField: attribute(password, 'name') ?? 'password',
      hidden,
    };
  }
  return undefined;
}
