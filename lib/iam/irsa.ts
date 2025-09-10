import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export function slug(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function roleName(project: string, env: string, service: string) {
    return `gen3-${slug(project)}-${slug(env)}-${slug(service)}-role`.slice(0, 64);
}

export function federatedPrincipalFromSsm(scope: Construct, project: string, env: string, ns: string, sa: string) {
    const prefix = `/gen3/${slug(project)}-${slug(env)}`;
    const issuer = ssm.StringParameter.valueForStringParameter(scope, `${prefix}/oidcIssuer`);
    const providerArn = ssm.StringParameter.valueForStringParameter(scope, `${prefix}/oidcProviderArn`);
    return new iam.FederatedPrincipal(
        providerArn,
        { StringEquals: { [`${issuer}:aud`]: "sts.amazonaws.com", [`${issuer}:sub`]: `system:serviceaccount:${ns}:${sa}` } },
        "sts:AssumeRoleWithWebIdentity"
    );
}

export function tagStandard(role: iam.Role, project: string, env: string, ns: string, sa: string) {
    const prefix = `/gen3/${slug(project)}-${slug(env)}`;
    const clusterName = ssm.StringParameter.valueForStringParameter(role, `${prefix}/clusterName`);
    iam.TagManager.of(role).setTag("Project", project);
    iam.TagManager.of(role).setTag("Environment", env);
    iam.TagManager.of(role).setTag("KubernetesNamespace", ns);
    iam.TagManager.of(role).setTag("KubernetesServiceAccount", sa);
    iam.TagManager.of(role).setTag("ClusterName", clusterName);
}
