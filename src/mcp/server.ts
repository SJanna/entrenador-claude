/**
 * Servidor MCP con transporte streamable HTTP en modo stateless, sin
 * dependencias: exactamente lo que necesita un conector personalizado de la
 * app de Claude. Implementa initialize, ping, tools/list y tools/call.
 */

import type { ToolDefinition } from "../tools/registry";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  status = 200,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

export interface McpServerOptions {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: ToolDefinition[];
}

export async function handleMcpRequest(
  request: Request,
  options: McpServerOptions,
): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Sin stream SSE de servidor y sin sesiones que borrar: modo stateless.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "El cuerpo no es JSON válido.", 400);
  }

  if (Array.isArray(body)) {
    return rpcError(
      null,
      -32600,
      "Los lotes JSON-RPC no están soportados (protocolo MCP 2025-06-18).",
      400,
    );
  }

  const message = body as JsonRpcRequest;
  const method = String(message.method ?? "");
  const hasId = message.id !== undefined && message.id !== null;
  const id = hasId ? message.id! : null;

  // Notificaciones y respuestas del cliente: aceptar sin cuerpo.
  if (!hasId || method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  const params = message.params ?? {};

  switch (method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: options.name,
          title: options.title,
          version: options.version,
        },
        instructions: options.instructions,
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      });

    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = options.tools.find((t) => t.name === name);
      if (!tool) {
        return rpcError(id, -32602, `Herramienta desconocida: ${name || "(sin nombre)"}.`);
      }
      const rawArgs = params.arguments;
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      try {
        const text = await tool.run(args);
        const isError = text.startsWith("Error");
        return rpcResult(id, {
          content: [{ type: "text", text }],
          isError,
        });
      } catch (exc) {
        // Red de seguridad: las herramientas ya convierten sus errores en texto.
        const detail = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
        return rpcResult(id, {
          content: [
            { type: "text", text: `Error inesperado ejecutando ${name}: ${detail}` },
          ],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Método no soportado: ${method}.`);
  }
}
