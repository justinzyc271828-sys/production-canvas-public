# Windows signing

The initial Windows portable release is unsigned. Its SHA-256 checksum is
published with the release, and the executable records its build commit.
Windows may display an unknown-publisher or SmartScreen warning.

A trusted code signature identifies the publisher and protects the signed
bytes against undetected modification. Initial certificate enrollment
requires identity validation. After a signing identity is configured,
signing can be automated for later releases.

## Available routes

- Microsoft Store MSIX distribution is re-signed by the Store after
  certification. It requires a developer account, an MSIX identity and a
  Store submission.
- Azure Artifact Signing supports automated EXE signing. Microsoft lists
  a reference cost of about USD 9.99 per month and eligibility conditions
  based on the publisher's identity and region.
- A certificate authority can provide another code-signing certificate
  route, usually with a hardware token or managed key service.

New signed files may still need to establish SmartScreen reputation.
Microsoft documents the current options and requirements in
[code signing options for Windows developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Release checks after signing is configured

1. Build from a clean commit and verify the application.
2. Sign the executable and apply the provider's trusted timestamp.
3. Check the signature with Get-AuthenticodeSignature.
4. Calculate the SHA-256 of the signed file and upload that exact file.

This repository contains no certificate private key or signing-service
credential. Publishing through this project's current build workflow does
not enroll a signing account.
