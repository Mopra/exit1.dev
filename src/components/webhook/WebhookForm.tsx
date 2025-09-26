"use client"

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Button,
  Input,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormDescription,
  FormMessage,
  Textarea,
  ScrollArea,
} from '../ui';
import { 
  Plus,
  X,
  Webhook,
  Check
} from 'lucide-react';

import { WEBHOOK_EVENTS } from '../../lib/webhook-events';

const formSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  url: z.string().url('Please enter a valid HTTPS URL'),
  events: z.array(z.string()).min(1, 'Please select at least one event type'),
  secret: z.string().optional(),
  customHeaders: z.string().optional(),
  webhookType: z.enum(['slack', 'discord', 'generic']),
});

type FormData = z.infer<typeof formSchema>;

interface WebhookFormProps {
  onSubmit: (data: {
    name: string;
    url: string;
    events: string[];
    secret?: string;
    headers?: { [key: string]: string };
    webhookType?: 'slack' | 'discord' | 'generic';
  }) => void;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  editingWebhook?: {
    id: string;
    name: string;
    url: string;
    events: string[];
    secret?: string;
    headers?: { [key: string]: string };
    webhookType?: 'slack' | 'discord' | 'generic';
  } | null;
}

// Event types now sourced from WEBHOOK_EVENTS (shared)

export default function WebhookForm({ onSubmit, loading = false, isOpen, onClose, editingWebhook }: WebhookFormProps) {
  const [currentStep, setCurrentStep] = useState(1);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      url: '',
      events: [],
      secret: '',
      customHeaders: '',
      webhookType: 'generic',
    },
  });

  // (Removed unused watchers)

  // Reset wizard step when opening
  React.useEffect(() => {
    if (isOpen) {
      setCurrentStep(1);
    }
  }, [isOpen]);

  // Reset form when editing webhook changes
  React.useEffect(() => {
    if (isOpen && editingWebhook) {
      form.reset({
        name: editingWebhook.name,
        url: editingWebhook.url,
        events: editingWebhook.events,
        secret: editingWebhook.secret || '',
        customHeaders: editingWebhook.headers ? JSON.stringify(editingWebhook.headers, null, 2) : '',
        webhookType: editingWebhook.webhookType || 'generic',
      });
    } else if (isOpen && !editingWebhook) {
      form.reset({
        name: '',
        url: '',
        events: [],
        secret: '',
        customHeaders: '',
        webhookType: 'generic',
      });
    }
  }, [editingWebhook?.id]); // Only depend on the ID, not the entire object

  const handleClose = () => {
    form.reset();
    setCurrentStep(1);
    onClose();
  };

  const handleSubmit = (data: FormData) => {
    try {
      let headers = {};
      if (data.customHeaders?.trim()) {
        headers = JSON.parse(data.customHeaders);
      }

      onSubmit({
        name: data.name,
        url: data.url,
        events: data.events,
        secret: data.secret || undefined,
        headers,
        webhookType: data.webhookType,
      });

      handleClose();
    } catch (error) {
      form.setError('customHeaders', {
        type: 'manual',
        message: 'Invalid JSON format'
      });
    }
  };

  const validateStep = async (step: number) => {
    if (step === 1) {
      // Validate name and url before proceeding
      const valid = await form.trigger(["name", "url"], { shouldFocus: true });
      return valid;
    }
    if (step === 2) {
      const valid = await form.trigger(["events"], { shouldFocus: true });
      return valid;
    }
    return true;
  };

  const nextStep = async () => {
    if (currentStep < 3) {
      const ok = await validateStep(currentStep);
      if (ok) setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
          onClick={handleClose}
        />
      )}
      
      {/* Slide-out Panel */}
      <div
        className={`
        fixed top-0 right-0 h-full w-full max-w-md bg-background border-l shadow-2xl z-50
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : 'translate-x-full'}
      `}
      >
          <ScrollArea className="h-full">
            <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                  <Webhook className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">
                    {editingWebhook ? 'Edit Webhook' : 'New Webhook'}
                  </h2>
                  <p className="text-xs text-muted-foreground">Step {currentStep} of 3</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Progress Steps */}
            <div className="flex items-center gap-2">
              {[1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`flex-1 h-1 rounded-full transition-colors ${
                    step <= currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              ))}
            </div>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(
                  handleSubmit,
                  (errors) => {
                    // Route user back to the step with the first error and focus it
                    if (errors.name || errors.url) {
                      setCurrentStep(1);
                      if (errors.url) form.setFocus('url');
                      else if (errors.name) form.setFocus('name');
                      return;
                    }
                    if (errors.events) {
                      setCurrentStep(2);
                      return;
                    }
                    setCurrentStep(3);
                  }
                )}
                className="space-y-6"
              >
                {/* Step 1: Basic Information */}
                {currentStep === 1 && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-sm font-medium text-foreground mb-4">Basic Information</h3>
                      
                      <div className="space-y-4">
                        <FormField
                          control={form.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Name</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="Slack Alerts"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                A descriptive name for this webhook
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="url"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>URL</FormLabel>
                              <FormControl>
                                <Input
                                  type="url"
                                  placeholder="https://webhook.site/your-unique-id"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                Only HTTPS URLs are allowed.
                              </FormDescription>
                              <FormDescription>
                                Get a test URL from{' '}
                                <a 
                                  href="https://webhook.site" 
                                  target="_blank" 
                                  rel="noopener noreferrer" 
                                  className="text-primary hover:underline"
                                >
                                  webhook.site
                                </a>
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="webhookType"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Webhook Type</FormLabel>
                              <FormControl>
                                <select 
                                  {...field} 
                                  className="w-full p-2 border border-input bg-background rounded-md text-sm"
                                >
                                  <option value="generic">Generic Webhook</option>
                                  <option value="slack">Slack</option>
                                  <option value="discord">Discord</option>
                                </select>
                              </FormControl>
                              <FormDescription>
                                Choose the platform you're sending notifications to
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-6 border-t">
                      <div className="text-xs text-muted-foreground">
                        Fields marked in red must be fixed before proceeding.
                      </div>
                      <Button
                        type="button"
                        onClick={nextStep}
                        className="h-8 px-4"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}

                {/* Step 2: Event Types */}
                {currentStep === 2 && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-sm font-medium text-foreground mb-4">Event Types</h3>
                      
                        <FormField
                          control={form.control}
                          name="events"
                          render={({ field }) => (
                              <FormItem>
                                <FormLabel>Select events to trigger this webhook</FormLabel>
                                <div className="space-y-3">
                                  {WEBHOOK_EVENTS.map((evt) => {
                                    const selected = (field.value || []).includes(evt.value)
                                    const id = `event-${evt.value}`
                                    const toggle = () => {
                                      const next = selected
                                        ? (field.value || []).filter((v: string) => v !== evt.value)
                                        : [...(field.value || []), evt.value]
                                      field.onChange(next)
                                    }
                                    return (
                                      <div key={evt.value} className="relative">
                                        <input
                                          id={id}
                                          name={field.name}
                                          type="checkbox"
                                          className="peer sr-only"
                                          checked={selected}
                                          onChange={toggle}
                                        />
                                        {(() => {
                                          const hoverBg = evt.color === 'red'
                                            ? 'hover:bg-destructive/10 dark:hover:bg-destructive/10'
                                            : evt.color === 'green'
                                            ? 'hover:bg-primary/10 dark:hover:bg-primary/10'
                                            : 'hover:bg-primary/10 dark:hover:bg-primary/10'
                                          const hoverBorder = evt.color === 'red'
                                            ? 'hover:border-destructive dark:hover:border-destructive'
                                            : evt.color === 'green'
                                            ? 'hover:border-primary dark:hover:border-primary'
                                            : 'hover:border-primary'
                                          return (
                                            <label
                                              htmlFor={id}
                                              className={`flex items-center gap-4 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer group ${hoverBg} ${
                                                selected
                                                  ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                                  : `border-border ${hoverBorder}`
                                              }`}
                                            >
                                              {(() => {
                                                const base = evt.color === 'red'
                                                  ? { selected: 'bg-destructive text-destructive-foreground', idle: 'bg-destructive/10 text-destructive' }
                                                  : evt.color === 'green'
                                                  ? { selected: 'bg-primary text-primary-foreground', idle: 'bg-primary/10 text-primary' }
                                                  : { selected: 'bg-primary text-primary-foreground', idle: 'bg-primary/10 text-primary' }
                                                const Icon = evt.icon
                                                return (
                                                  <div
                                                    className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                                                      selected ? base.selected : base.idle
                                                    }`}
                                                  >
                                                    <Icon className="w-5 h-5" />
                                                  </div>
                                                )
                                              })()}
                                              <div className="flex-1">
                                                <div className="font-medium text-sm">{evt.label}</div>
                                                <div className="text-xs text-muted-foreground">{evt.description}</div>
                                              </div>
                                              <Check
                                                className={`w-5 h-5 transition-all ${
                                                  selected
                                                    ? 'text-primary opacity-100 scale-100'
                                                    : 'text-muted-foreground opacity-0 scale-90'
                                                }`}
                                              />
                                            </label>
                                          )
                                        })()}
                                      </div>
                                    )
                                  })}
                                </div>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                    </div>

                    <div className="flex items-center justify-between pt-6 border-t">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={prevStep}
                        className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        Back
                      </Button>
                      <Button
                        type="button"
                        onClick={nextStep}
                        className="h-8 px-4"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}

                {/* Step 3: Advanced Settings */}
                {currentStep === 3 && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-sm font-medium text-foreground mb-4">Advanced Settings</h3>
                      
                      <div className="space-y-4">
                        <FormField
                          control={form.control}
                          name="secret"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Secret (Optional)</FormLabel>
                              <FormControl>
                                <Input
                                  type="password"
                                  placeholder="Optional"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                Adds X-Exit1-Signature header with HMAC-SHA256 hash for verification
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="customHeaders"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Custom Headers (Optional)</FormLabel>
                              <FormControl>
                                <Textarea
                                  placeholder='{\n  "Authorization": "Bearer your-token"\n}'
                                  className="font-mono text-sm resize-y min-h-[100px]"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                JSON format for additional headers
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-6 border-t">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={prevStep}
                        className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        Back
                      </Button>
                      <Button
                        type="submit"
                        disabled={loading}
                        className="h-8 px-4 gap-2"
                      >
                        {loading ? (
                          <>
                            <div className="w-4 h-4 border-2 border-background border-t-foreground rounded-full animate-spin" />
                            {editingWebhook ? 'Updating...' : 'Creating...'}
                          </>
                        ) : (
                          <>
                            <Plus className="w-4 h-4" />
                            {editingWebhook ? 'Update Webhook' : 'Create Webhook'}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </form>
            </Form>
            </div>
          </ScrollArea>
      </div>
    </>
  );
}
