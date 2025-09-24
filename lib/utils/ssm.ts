import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/** Slugify to [a-z0-9-], collapse dashes, trim ends */
export function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Read a required SSM parameter at **synth-time**.
 * Fails fast if the key doesn't exist (throws), so you catch mistakes early.
 * Requires the stack to be environment-bound (account+region) and credentials at synth.
 */
export function readRequired(scope: Construct, path: string): string {
    return ssm.StringParameter.valueFromLookup(scope, path);
}

/**
 * Read an optional SSM parameter at **synth-time**.
 * Returns undefined if the key doesn't exist.
 * Same requirements as readRequired (env-bound stack + credentials).
 */
export function readOptional(scope: Construct, path: string): string | undefined {
    try {
        return ssm.StringParameter.valueFromLookup(scope, path);
    } catch {
        return undefined;
    }
}

/**
 * Read a parameter as a **deploy-time token** (CloudFormation dynamic reference).
 * Use this when you don't need presence detection at synth (e.g., for tag values, trust conditions).
 * This never throws at synth; it resolves during deployment.
 */
export function readDeployTime(scope: Construct, path: string, version?: number): string {
    return ssm.StringParameter.valueForStringParameter(scope, path, version);
}
