name: Move GCP infrastructure to managed service
description: Propose converting the Google Cloud Platform (GCP) provisioning logic into a managed service or platform-as-a-service model.

labels: [enhancement, gcp, infra]
body:
  - type: markdown
    attributes:
      value: |
        ## Overview
        This issue is used to track proposals for moving the GCP-specific infrastructure provisioning (VM creation, GPU attachment, networking, etc.) from a custom Terraform-based script into a managed service.

  - type: textarea
    id: motivation
    attributes:
      label: Motivation
      description: Why do you want to move this functionality? What problems does it solve?
      placeholder: "e.g., reduce operational overhead, improve consistency across environments..."

  - type: textarea
    id: scope
    attributes:
      label: Scope of Change
      description: Which parts of the GCP infrastructure should be moved? (VMs, GPUs, networking, DNS, etc.)
      placeholder: "List components to be managed externally or internally."

  - type: input
    id: target_service
    attributes:
      label: Target Managed Service (Optional)
      description: If you have a specific managed service in mind (e.g., Google Cloud Run, Kubernetes Engine, etc.), specify it here.
      placeholder: "e.g., GKE, Cloud Functions, Custom Platform..."

  - type: textarea
    id: current_state
    attributes:
      label: Current State
      description: Describe how the GCP infrastructure is currently provisioned and managed in gpushed.
      placeholder: "Currently using Terraform with custom scripts in `scripts/startup-wrapper.sh` and `box.sh`..."

  - type: textarea
    id: proposed_solution
    attributes:
      label: Proposed Solution
      description: Outline your proposal for moving the GCP part to a managed service. Include any architectural changes, trade-offs, or dependencies.
      placeholder: "Describe how you envision the new architecture working..."

  - type: textarea
    id: risks
    attributes:
      label: Risks and Considerations
      description: What are the potential risks, challenges, or downsides of this change?
      placeholder: "e.g., increased cost, reduced flexibility, dependency on external service..."

  - type: checkboxes
    id: acceptance_criteria
    attributes:
      label: Acceptance Criteria
      description: What must be true for this proposal to be considered complete?
      options:
        - label: Clear motivation and scope defined
        - label: Proposed solution is technically feasible
        - label: Risks are acknowledged and mitigated where possible

  - type: textarea
    id: additional_context
    attributes:
      label: Additional Context (Optional)
      description: Any other information that might be helpful, such as references to related issues or documentation.
