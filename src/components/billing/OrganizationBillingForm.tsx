import { useEffect, useRef, useState } from "react"
import {
  OrganizationSwitcher,
  useClerk,
  useOrganization,
  useOrganizationList,
} from "@clerk/clerk-react"
import { Building2, CheckCircle2, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Label } from "@/components/ui/Label"
import { Separator } from "@/components/ui/separator"
import { apiClient } from "@/api/client"
import type { OrganizationBillingAddress, OrganizationBillingProfile } from "@/api/types"
import {
  createEmptyOrganizationProfile,
  buildOrganizationProfileState,
  normalizeOrganizationProfileForSave,
  parseOrganizationBillingProfile,
  validateVatId,
} from "@/lib/billing-profile"

export function OrganizationBillingForm() {
  const { organization } = useOrganization()
  const { isLoaded: isOrgListLoaded, setActive, userMemberships } =
    useOrganizationList({ userMemberships: { infinite: true } })
  const { openCreateOrganization, openOrganizationProfile } = useClerk()

  const [formProfile, setFormProfile] = useState<OrganizationBillingProfile>(
    () => createEmptyOrganizationProfile(),
  )
  const [savedProfile, setSavedProfile] = useState<OrganizationBillingProfile | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [taxIdError, setTaxIdError] = useState<string | undefined>(undefined)
  const justSavedRef = useRef(false)

  // Stabilize metadata dependency with JSON serialization to avoid spurious re-runs
  const orgMetadataKey = organization?.publicMetadata
    ? JSON.stringify(organization.publicMetadata)
    : null

  useEffect(() => {
    if (justSavedRef.current) {
      justSavedRef.current = false
      return
    }

    if (!organization) {
      setFormProfile(createEmptyOrganizationProfile())
      setSavedProfile(null)
      setSaveError(null)
      setSaveSuccess(null)
      return
    }

    const metadata = organization.publicMetadata as Record<string, unknown> | null | undefined
    const profile = parseOrganizationBillingProfile(metadata)
    setFormProfile(buildOrganizationProfileState(profile))
    setSavedProfile(profile)
    setSaveError(null)
    setSaveSuccess(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id, orgMetadataKey])

  const address: OrganizationBillingAddress = formProfile.address ?? {}
  const memberships = userMemberships?.data ?? []
  const hasOrganizations = isOrgListLoaded && memberships.length > 0
  const primaryOrg = memberships[0]?.organization

  const setField = (field: keyof OrganizationBillingProfile, value: string) => {
    setFormProfile((cur) => ({ ...cur, [field]: value }))
    setSaveError(null)
    setSaveSuccess(null)
    if (field === "taxId") setTaxIdError(validateVatId(value))
  }

  const setAddressField = (field: keyof OrganizationBillingAddress, value: string) => {
    setFormProfile((cur) => ({
      ...cur,
      address: { ...(cur.address ?? {}), [field]: value },
    }))
    setSaveError(null)
    setSaveSuccess(null)
  }

  const handleSave = async () => {
    if (!organization) return
    const vatError = validateVatId(formProfile.taxId ?? "")
    if (vatError) {
      setTaxIdError(vatError)
      setSaveError("Please fix the validation errors before saving.")
      return
    }

    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(null)

    const normalized = normalizeOrganizationProfileForSave(formProfile)

    try {
      const result = await apiClient.updateOrganizationBillingProfile(
        organization.id,
        normalized,
      )
      if (!result.success) {
        setSaveError(result.error || "Failed to update organization billing profile")
        return
      }

      justSavedRef.current = true
      setSavedProfile(normalized)
      setFormProfile(buildOrganizationProfileState(normalized))
      setSaveSuccess("Organization billing details saved.")
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setFormProfile(buildOrganizationProfileState(savedProfile))
    setSaveError(null)
    setSaveSuccess(null)
  }

  return (
    <Card className="bg-card border-0 shadow-lg">
      <CardHeader className="p-4 sm:p-6 lg:p-8">
        <CardTitle className="text-xl">Organization Billing</CardTitle>
        <CardDescription>
          Configure company details for receipts and invoices.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Billing Entity Section */}
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Billing entity</p>
            <p className="text-xs text-muted-foreground">
              Choose whether receipts should use your personal details or the organization profile.
            </p>
          </div>
          {hasOrganizations ? (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-lg border bg-background/40 backdrop-blur">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {organization?.name ?? "Personal account"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {organization ? "Receipts use organization details." : "Receipts use personal details."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {organization ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setActive({ organization: null })}
                    className="cursor-pointer"
                  >
                    Switch to personal
                  </Button>
                ) : primaryOrg ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setActive({ organization: primaryOrg.id })}
                    className="cursor-pointer"
                  >
                    Switch to organization
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openOrganizationProfile()}
                  className="cursor-pointer"
                  disabled={!organization}
                >
                  Manage organization
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <OrganizationSwitcher
                hidePersonal={false}
                afterCreateOrganizationUrl="/billing"
                afterSelectOrganizationUrl="/billing"
                afterLeaveOrganizationUrl="/billing"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    void openCreateOrganization({
                      skipInvitationScreen: true,
                      afterCreateOrganizationUrl: "/billing",
                    })
                  }
                  className="cursor-pointer"
                >
                  Create organization
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void openOrganizationProfile()}
                  className="cursor-pointer"
                  disabled={!organization}
                >
                  Manage organization
                </Button>
              </div>
            </div>
          )}
        </div>

        {organization ? (
          <div className="space-y-8">
            {/* Organization Selected Notice */}
            <div className="rounded-lg border bg-primary/5 border-primary/20 p-4">
              <p className="text-sm font-medium text-primary mb-1">Organization selected</p>
              <p className="text-xs text-muted-foreground">
                Receipts will use the saved organization details below.
              </p>
            </div>

            {/* Company Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Company Information</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="org-company-name">Company name</Label>
                  <Input
                    id="org-company-name"
                    value={formProfile.companyName ?? ""}
                    onChange={(e) => setField("companyName", e.target.value)}
                    placeholder={organization?.name ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-legal-name">Legal name</Label>
                  <Input
                    id="org-legal-name"
                    value={formProfile.legalName ?? ""}
                    onChange={(e) => setField("legalName", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-email">Billing email</Label>
                  <Input
                    id="org-email"
                    type="email"
                    value={formProfile.email ?? ""}
                    onChange={(e) => setField("email", e.target.value)}
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-phone">Phone</Label>
                  <Input
                    id="org-phone"
                    type="tel"
                    value={formProfile.phone ?? ""}
                    onChange={(e) => setField("phone", e.target.value)}
                    autoComplete="tel"
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Address */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Address</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="org-address-line1">Address line 1</Label>
                  <Input id="org-address-line1" value={address.line1 ?? ""} onChange={(e) => setAddressField("line1", e.target.value)} autoComplete="address-line1" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="org-address-line2">Address line 2</Label>
                  <Input id="org-address-line2" value={address.line2 ?? ""} onChange={(e) => setAddressField("line2", e.target.value)} autoComplete="address-line2" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-city">City</Label>
                  <Input id="org-city" value={address.city ?? ""} onChange={(e) => setAddressField("city", e.target.value)} autoComplete="address-level2" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-region">State/Region</Label>
                  <Input id="org-region" value={address.region ?? ""} onChange={(e) => setAddressField("region", e.target.value)} autoComplete="address-level1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-postal">Postal code</Label>
                  <Input id="org-postal" value={address.postalCode ?? ""} onChange={(e) => setAddressField("postalCode", e.target.value)} autoComplete="postal-code" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-country">Country</Label>
                  <Input id="org-country" value={address.country ?? ""} onChange={(e) => setAddressField("country", e.target.value)} autoComplete="country-name" />
                </div>
              </div>
            </div>

            <Separator />

            {/* Tax Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Tax Information</h3>
              <div className="space-y-2">
                <Label htmlFor="org-tax-id">VAT ID</Label>
                <Input
                  id="org-tax-id"
                  value={formProfile.taxId ?? ""}
                  onChange={(e) => setField("taxId", e.target.value)}
                  onBlur={() => setTaxIdError(validateVatId(formProfile.taxId ?? ""))}
                  placeholder="DK46156153"
                  className={taxIdError ? "border-destructive" : ""}
                />
                {taxIdError ? (
                  <p className="text-sm text-destructive">{taxIdError}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Enter your VAT ID with country code prefix (e.g., DK46156153, GB123456789)
                  </p>
                )}
              </div>
            </div>

            <Separator />

            {/* Custom Fields */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Custom Fields</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newKey = `Field ${Object.keys(formProfile.customFields ?? {}).length + 1}`
                    setFormProfile((cur) => ({
                      ...cur,
                      customFields: { ...(cur.customFields ?? {}), [newKey]: "" },
                    }))
                  }}
                  className="cursor-pointer"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add field
                </Button>
              </div>
              {Object.keys(formProfile.customFields ?? {}).length > 0 ? (
                <div className="space-y-3">
                  {Object.entries(formProfile.customFields ?? {}).map(([key, value], index) => (
                    <div key={index} className="grid gap-3 md:grid-cols-[1fr_2fr_auto] items-end">
                      <Input
                        placeholder="Field name"
                        value={key}
                        onChange={(e) => {
                          const newKey = e.target.value
                          const oldValue = formProfile.customFields?.[key] ?? ""
                          setFormProfile((cur) => {
                            const fields = { ...(cur.customFields ?? {}) }
                            delete fields[key]
                            if (newKey.trim()) fields[newKey] = oldValue
                            return { ...cur, customFields: fields }
                          })
                        }}
                      />
                      <Input
                        placeholder="Value"
                        value={value}
                        onChange={(e) => {
                          setFormProfile((cur) => ({
                            ...cur,
                            customFields: { ...(cur.customFields ?? {}), [key]: e.target.value },
                          }))
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setFormProfile((cur) => {
                            const fields = { ...(cur.customFields ?? {}) }
                            delete fields[key]
                            return { ...cur, customFields: fields }
                          })
                        }}
                        className="cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Add custom fields like internal reference, ID, or any other information you need on receipts.
                </p>
              )}
            </div>

            <Separator />

            {/* Save Actions */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="default"
                  onClick={() => void handleSave()}
                  className="cursor-pointer"
                  disabled={isSaving}
                >
                  {isSaving ? "Saving..." : "Save organization"}
                </Button>
                <Button variant="ghost" onClick={handleReset} className="cursor-pointer">
                  Reset
                </Button>
              </div>
              {saveError && <p className="text-sm text-destructive">{saveError}</p>}
              {saveSuccess && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  {saveSuccess}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
            <p className="text-sm font-medium mb-2">No organization selected</p>
            <p className="text-sm text-muted-foreground mb-4">
              Select or create an organization to add company details to receipts.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {!hasOrganizations && (
                <Button
                  variant="default"
                  onClick={() =>
                    void openCreateOrganization({
                      skipInvitationScreen: true,
                      afterCreateOrganizationUrl: "/billing",
                    })
                  }
                  className="cursor-pointer"
                >
                  Create organization
                </Button>
              )}
              {hasOrganizations && primaryOrg && (
                <Button
                  variant="default"
                  onClick={() => void setActive({ organization: primaryOrg.id })}
                  className="cursor-pointer"
                >
                  Switch to organization
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
