import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/** Required param (throws at synth if missing). */
export function readRequired(scope: Construct, path: string): string {
    return ssm.StringParameter.valueForStringParameter(scope, path);
}

/** Optional param (returns undefined if missing). */
export function readOptional(scope: Construct, path: string): string | undefined {
    try {
        return ssm.StringParameter.valueForStringParameter(scope, path);
    } catch {
        return undefined;
    }
}
