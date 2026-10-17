// These are the public account-service URL and OAuth client identifier shipped
// by the original plugin. They are not user credentials or a client secret.
const OFFICIAL_ACCOUNT_WEBSITE = "https://remotelysave.com";
const OFFICIAL_PUBLIC_CLIENT_ID =
  "cli-RcskZDNbskll95WHJ3rNa8G34YlD3DML3cmwGOpEpbpvm82rIVGWmQMKJ60NjjGJKB6H_fOeHicW9W0H";

const resolveAccountBuildConfig = (env = {}) => {
  const website = env.REMOTELYSAVE_WEBSITE?.trim() || OFFICIAL_ACCOUNT_WEBSITE;
  const clientId =
    env.REMOTELYSAVE_CLIENT_ID?.trim() || OFFICIAL_PUBLIC_CLIENT_ID;
  const url = new URL(website);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw Error(
      "REMOTELYSAVE_WEBSITE must be an absolute HTTP(S) URL without credentials"
    );
  }
  return { website: website.replace(/\/+$/, ""), clientId };
};

module.exports = { resolveAccountBuildConfig };
