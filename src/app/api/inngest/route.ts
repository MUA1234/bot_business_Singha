/**
 * Inngest serve endpoint. Inngest calls this URL to run durable functions. Wired
 * once INNGEST_* keys are configured (see CONFIGURATION_GUIDE.md).
 */
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
