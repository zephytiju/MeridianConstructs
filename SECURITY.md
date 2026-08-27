<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security policy

Report suspected vulnerabilities privately through GitHub Security Advisories. Do not place
credentials, private endpoints, tenant data, secret values, identity tokens, or Pulumi state in
public issues.

MeridianConstructs accepts opaque identity and secret locators only. Runtime configuration and
component outputs must never contain secret bytes. Provider credentials and stack state remain
owned by the calling Platform or Vangu IaC stack.
