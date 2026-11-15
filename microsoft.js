export const authority = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const graph = "https://graph.microsoft.com/v1.0";
const mailScope = "https://graph.microsoft.com/Mail.Read";
export const authorizationScope = `offline_access ${mailScope} https://graph.microsoft.com/User.Read`;

export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function microsoft(fetcher = fetch) {
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
    } catch {
      throw new AppError(503, "暂时无法连接微软，请稍后重试。", "unavailable");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AppError(503, "微软服务暂时不可用，请稍后重试。", "unavailable");
    }
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  async function token(parameters) {
    const { response, data } = await request(`${authority}/token`, {
      method: "POST",
      body: new URLSearchParams(parameters)
    });
    if (response.ok && typeof data?.access_token === "string") return data;
    if (["invalid_grant", "interaction_required", "consent_required"].includes(data?.error)) {
      throw new AppError(409, "微软未接受这份授权。请检查 Client ID 和令牌是否匹配，或重新授权。", "reauthorize");
    }
    if (data?.error === "invalid_scope") throw new AppError(422, "这份授权无法用于 Graph 读取邮件。请用 Microsoft 重新授权。", "scope");
    if (["invalid_client", "unauthorized_client"].includes(data?.error)) {
      throw new AppError(422, "微软未接受应用凭据。请检查 Client ID 或应用配置。", "client");
    }
    throw new AppError(502, "微软未能发放访问令牌。", "upstream");
  }

  async function graphGet(endpoint, accessToken, query, text = false) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (text) headers.Prefer = 'outlook.body-content-type="text"';
    const url = new URL(`${graph}${endpoint}`);
    url.search = new URLSearchParams(query);
    const { response, data } = await request(url, { headers });
    if (response.ok && data) return data;
    if (response.status === 401) throw new AppError(409, "访问令牌未被接受，请刷新或重新授权。", "access");
    if (response.status === 403) throw new AppError(422, "当前授权缺少读取权限，请用 Microsoft 重新授权。", "scope");
    if (response.status === 404) throw new AppError(404, "微软未找到这封邮件或邮箱文件夹。", "missing");
    throw new AppError(502, "微软暂时无法读取该邮箱。", "upstream");
  }

  function messageFields({ id, subject, from, receivedDateTime, bodyPreview }) {
    return {
      id, subject: subject || "（无主题）", sender: from?.emailAddress?.name || "未知发件人",
      address: from?.emailAddress?.address || "", receivedDateTime, snippet: bodyPreview || ""
    };
  }

  return {
    token,
    refresh(account, secret) {
      return token({
        grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken,
        scope: account.source === "microsoft" ? authorizationScope : mailScope,
        ...(secret ? { client_secret: secret } : {})
      });
    },
    profile(accessToken) {
      return graphGet("/me", accessToken, { $select: "id,mail,userPrincipalName" });
    },
    async list(accessToken, folder) {
      const result = await graphGet(`/me/mailFolders/${folder}/messages`, accessToken, {
        $select: "id,subject,from,receivedDateTime,bodyPreview", $top: "30", $orderby: "receivedDateTime desc"
      });
      if (!Array.isArray(result.value)) throw new AppError(502, "微软返回了无法读取的邮件列表。", "upstream");
      return result.value.map(messageFields);
    },
    async message(accessToken, id) {
      const result = await graphGet(`/me/messages/${encodeURIComponent(id)}`, accessToken, {
        $select: "id,subject,from,receivedDateTime,bodyPreview,body"
      }, true);
      return {
        ...messageFields(result),
        body: result.body?.contentType === "text" ? result.body.content : result.bodyPreview || ""
      };
    }
  };
}
