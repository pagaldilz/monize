import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AiModule } from "../ai/ai.module";
import { McpModule } from "../mcp/mcp.module";
import { AiAgentService } from "./ai-agent.service";
import { AiAgentController } from "./ai-agent.controller";

/**
 * The MCP-powered AI Agent chatbox module.
 *
 * - {@link AiModule} supplies the provider factory (`AiService.getToolUseProvider`)
 *   and the shared financial context builder + usage logging, so the agent
 *   uses the exact same provider configuration as the AI Assistant.
 * - {@link McpModule} supplies {@link AiAgentToolRegistry}, the in-process
 *   bridge to all 65 MCP tools with their scope/limiter/dryRun guards intact.
 *
 * The agent never imports the domain modules directly — all data access flows
 * through the MCP tool handlers, preserving the existing authorization model.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserPreference]),
    AiModule,
    McpModule,
  ],
  providers: [AiAgentService],
  controllers: [AiAgentController],
})
export class AiAgentModule {}
