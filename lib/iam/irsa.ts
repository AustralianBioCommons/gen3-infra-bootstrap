import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";

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

export function tagStandard(scope: Construct, role: iam.Role, project: string, env: string, ns: string, sa: string) {
    const prefix = `/gen3/${project}-${env}`;
    const clusterName = ssm.StringParameter.valueForStringParameter(scope, `${prefix}/clusterName`);

    cdk.Tags.of(role).add("Project", project);
    cdk.Tags.of(role).add("Environment", env);
    cdk.Tags.of(role).add("KubernetesNamespace", ns);
    cdk.Tags.of(role).add("KubernetesServiceAccount", sa);
    cdk.Tags.of(role).add("ClusterName", clusterName);
}
