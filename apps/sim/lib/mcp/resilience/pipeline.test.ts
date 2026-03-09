import { test, expect, describe, mock } from 'bun:test'
import { ResiliencePipeline } from './pipeline'
import type { McpExecutionContext, McpMiddleware, McpMiddlewareNext } from './types'

const infoInfo = mock()
const errorError = mock()

// Mock logger before any imports of telemetry
mock.module('@sim/logger', () => ({
    createLogger: () => ({
        info: infoInfo,
        error: errorError,
        warn: mock(),
        debug: mock()
    })
}))

// Dynamically import TelemetryMiddleware so the mock applies
const { TelemetryMiddleware } = await import('./telemetry')
import { createLogger } from '@sim/logger'

describe('ResiliencePipeline', () => {
    const mockContext: McpExecutionContext = {
        toolCall: { name: 'test_tool', arguments: {} },
        serverId: 'server-1',
        userId: 'user-1',
        workspaceId: 'workspace-1'
    }

    test('should execute middlewares in order', async () => {
        const pipeline = new ResiliencePipeline()
        const order: number[] = []

        const m1: McpMiddleware = {
            execute: async (ctx, next) => {
                order.push(1)
                const res = await next(ctx)
                order.push(4)
                return res
            }
        }

        const m2: McpMiddleware = {
            execute: async (ctx, next) => {
                order.push(2)
                const res = await next(ctx)
                order.push(3)
                return res
            }
        }

        pipeline.use(m1).use(m2)

        const finalHandler: McpMiddlewareNext = async () => {
            return { content: [{ type: 'text', text: 'success' }] }
        }

        const result = await pipeline.execute(mockContext, finalHandler)

        expect(order).toEqual([1, 2, 3, 4])
        expect(result.content?.[0].text).toBe('success')
    })
})

describe('TelemetryMiddleware', () => {
    const mockContext: McpExecutionContext = {
        toolCall: { name: 'telemetry_tool', arguments: {} },
        serverId: 'server-2',
        userId: 'user-2',
        workspaceId: 'workspace-2'
    }

    test('should log success with latency', async () => {
        infoInfo.mockClear()

        const telemetry = new TelemetryMiddleware()

        const finalHandler: McpMiddlewareNext = async () => {
            // simulate some latency
            await new Promise(r => setTimeout(r, 10))
            return { content: [] }
        }

        await telemetry.execute(mockContext, finalHandler)

        expect(infoInfo).toHaveBeenCalled()
        const msg = infoInfo.mock.calls[0][0]
        const logCall = infoInfo.mock.calls[0][1]
        expect(msg).toBe('MCP Tool Execution Completed')
        expect(logCall.toolName).toBe('telemetry_tool')
        expect(logCall.latency_ms).toBeGreaterThanOrEqual(10)
        expect(logCall.success).toBe(true)
    })

    test('should log TOOL_ERROR when tool result has isError: true', async () => {
        infoInfo.mockClear()

        const telemetry = new TelemetryMiddleware()

        const finalHandler: McpMiddlewareNext = async () => {
            return { isError: true, content: [] }
        }

        await telemetry.execute(mockContext, finalHandler)

        expect(infoInfo).toHaveBeenCalled()
        const msg = infoInfo.mock.calls[0][0]
        const logCall = infoInfo.mock.calls[0][1]
        expect(msg).toBe('MCP Tool Execution Completed')
        expect(logCall.success).toBe(false)
        expect(logCall.failure_reason).toBe('TOOL_ERROR')
    })

    test('should log exception and rethrow with TIMEOUT explanation', async () => {
        errorError.mockClear()

        const telemetry = new TelemetryMiddleware()

        const finalHandler: McpMiddlewareNext = async () => {
            throw new Error('Connection timeout occurred')
        }

        let caughtError: Error | null = null
        try {
            await telemetry.execute(mockContext, finalHandler)
        } catch (e: any) {
            caughtError = e
        }

        expect(caughtError).toBeDefined()
        expect(errorError).toHaveBeenCalled()
        const msg = errorError.mock.calls[0][0]
        const logCall = errorError.mock.calls[0][1]
        expect(msg).toBe('MCP Tool Execution Failed')
        expect(logCall.failure_reason).toBe('TIMEOUT')
    })
})
