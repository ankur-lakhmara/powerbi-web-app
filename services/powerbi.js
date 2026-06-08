const axios = require('axios');

// Token cache keyed per credential set (one entry per platform + a 'default' entry)
const tokenCache = new Map();

// Resolves which Power BI master-user credentials to use for a request.
// Platforms may override the credentials in .env; any blank platform field
// falls back to the corresponding .env value.
function resolveCredentials(platform) {
  if (platform && platform.pbi_username && platform.pbi_password) {
    return {
      cacheKey:     `platform:${platform.id}`,
      clientId:     platform.pbi_client_id     || process.env.PBI_CLIENT_ID,
      username:     platform.pbi_username,
      password:     platform.pbi_password,
      authorityUrl: platform.pbi_authority_url || process.env.PBI_AUTHORITY_URL,
      scope:        platform.pbi_scope         || process.env.PBI_SCOPE,
      apiUrl:       platform.pbi_api_url       || process.env.PBI_API_URL
    };
  }

  return {
    cacheKey:     'default',
    clientId:     process.env.PBI_CLIENT_ID,
    username:     process.env.PBI_USERNAME,
    password:     process.env.PBI_PASSWORD,
    authorityUrl: process.env.PBI_AUTHORITY_URL,
    scope:        process.env.PBI_SCOPE,
    apiUrl:       process.env.PBI_API_URL
  };
}

async function getAccessToken(platform) {
  const creds  = resolveCredentials(platform);
  const cached = tokenCache.get(creds.cacheKey);

  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id:  creds.clientId,
    username:   creds.username,
    password:   creds.password,
    resource:   'https://analysis.windows.net/powerbi/api',
    scope:      'openid'
  });

  const response = await axios.post(
    `${creds.authorityUrl}/oauth2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const data = response.data;
  tokenCache.set(creds.cacheKey, {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in - 120) * 1000
  });

  return data.access_token;
}

async function getEmbedToken(pbiWorkspaceId, pbiReportId, platform) {
  const creds       = resolveCredentials(platform);
  const accessToken = await getAccessToken(platform);

  const response = await axios.post(
    `${creds.apiUrl}v1.0/myorg/groups/${pbiWorkspaceId}/reports/${pbiReportId}/GenerateToken`,
    { accessLevel: 'view' },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.token;
}

async function getReportEmbedUrl(pbiWorkspaceId, pbiReportId, platform) {
  const creds       = resolveCredentials(platform);
  const accessToken = await getAccessToken(platform);

  const response = await axios.get(
    `${creds.apiUrl}v1.0/myorg/groups/${pbiWorkspaceId}/reports/${pbiReportId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data.embedUrl;
}

async function getEmbedConfig(pbiWorkspaceId, pbiReportId, platform) {
  const [embedToken, embedUrl] = await Promise.all([
    getEmbedToken(pbiWorkspaceId, pbiReportId, platform),
    getReportEmbedUrl(pbiWorkspaceId, pbiReportId, platform)
  ]);

  return { embedToken, embedUrl, reportId: pbiReportId };
}

module.exports = { getEmbedConfig, getAccessToken };
