"use client"

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { 
  Button, 
  Input, 
  CheckIntervalSelector, 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormDescription,
  FormMessage,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  ScrollArea
} from '../ui';
import { 
  Globe, 
  Code,
  Plus,
  Zap,
  X,
  ArrowRight,
  Check
} from 'lucide-react';
// NOTE: No tier-based enforcement. Keep form behavior tier-agnostic for now.

const formSchema = z.object({
  name: z.string().min(1, 'Display name is required'),
  url: z.string().min(1, 'URL is required'),
  type: z.enum(['website', 'rest_endpoint']),
// Only allow supported values (in seconds): 60, 120, 300, 3600, 86400
  checkFrequency: z.union([
    z.literal(60),
    z.literal(120),
    z.literal(300),
    z.literal(3600),
    z.literal(86400),
  ]),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  expectedStatusCodes: z.string().optional(),
  requestHeaders: z.string().optional(),
  requestBody: z.string().optional(),
  containsText: z.string().optional(),
});

type FormData = z.infer<typeof formSchema>;

interface CheckFormProps {
  onSubmit: (data: {
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint';
    checkFrequency?: number;
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    expectedStatusCodes?: number[];
    requestHeaders?: { [key: string]: string };
    requestBody?: string;
    responseValidation?: {
      containsText?: string[];
      jsonPath?: string;
      expectedValue?: unknown;
    };
  }) => void;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  prefillWebsiteUrl?: string | null;
}

export default function CheckForm({ onSubmit, loading = false, isOpen, onClose, prefillWebsiteUrl }: CheckFormProps) {
  const [currentStep, setCurrentStep] = useState(1);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      url: prefillWebsiteUrl ? prefillWebsiteUrl.replace(/^https?:\/\//, '') : '',
      type: 'website',
      checkFrequency: 3600, // Default to 1 hour
      httpMethod: 'HEAD',
      expectedStatusCodes: '200,201,202,204,301,302,303,307,308,404,403,429',
      requestHeaders: '',
      requestBody: '',
      containsText: '',
    },
  });

  const watchHttpMethod = form.watch('httpMethod');

  // Ensure form closes when isOpen becomes false
  useEffect(() => {
    console.log('CheckForm isOpen changed:', isOpen);
    if (!isOpen) {
      form.reset();
      setCurrentStep(1);
    }
  }, [isOpen, form]);

  // Handle prefill website URL when form opens
  useEffect(() => {
    if (isOpen && prefillWebsiteUrl) {
      console.log('Prefilling form with website URL:', prefillWebsiteUrl);
      const cleanUrl = prefillWebsiteUrl.replace(/^https?:\/\//, '');
      form.setValue('url', cleanUrl);
      
      // Auto-generate name from the pre-filled URL
      try {
        const fullUrl = `https://${cleanUrl}`;
        const url = new URL(fullUrl);
        const hostname = url.hostname;
        
        if (hostname && hostname.length > 0) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[-_.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          if (!friendlyName || friendlyName.length < 2) {
            const domainWithoutExtension = hostname
              .replace(/^www\./, '')
              .split('.')
              .slice(0, -1)
              .join('.');
            friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
          }
          
          form.setValue('name', friendlyName);
          console.log('Generated friendly name:', friendlyName);
        }
      } catch (error) {
        console.error('Error generating name from URL:', error);
        // If URL parsing fails, just set the name to the domain
        form.setValue('name', cleanUrl);
      }
    }
  }, [isOpen, prefillWebsiteUrl, form]);

  // Auto-generate name from URL when URL changes
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    form.setValue('url', newUrl);
    
    if (!newUrl.trim()) {
      form.setValue('name', '');
      return;
    }
    
    try {
      if (newUrl.length > 0) {
        const fullUrl = `https://${newUrl}`;
        const url = new URL(fullUrl);
        const hostname = url.hostname;
        
        if (hostname && hostname.length > 0) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[-_.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          if (!friendlyName || friendlyName.length < 2) {
            const domainWithoutExtension = hostname
              .replace(/^www\./, '')
              .split('.')
              .slice(0, -1)
              .join('.');
            friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
          }
          
          form.setValue('name', friendlyName);
        }
      } else {
        form.setValue('name', '');
      }
    } catch {
      form.setValue('name', '');
    }
  };

  // Reset HTTP method and status codes when type changes
  const handleTypeChange = (newType: 'website' | 'rest_endpoint') => {
    form.setValue('type', newType);
    if (newType === 'website') {
      form.setValue('httpMethod', 'HEAD');
      form.setValue('expectedStatusCodes', '200,201,202,204,301,302,303,307,308,404,403,429');
    } else {
      form.setValue('httpMethod', 'GET');
      form.setValue('expectedStatusCodes', '200,201,202');
    }
  };

  const onFormSubmit = (data: FormData) => {
    console.log('Form submitted with data:', data);
    const fullUrl = `https://${data.url}`;
    console.log('Full URL:', fullUrl);
    
    const statusCodes = data.expectedStatusCodes
      ? data.expectedStatusCodes
          .split(',')
          .map((s: string) => parseInt(s.trim()))
          .filter((n: number) => !isNaN(n))
      : undefined;
    
    const headers: { [key: string]: string } = {};
    if (data.requestHeaders?.trim()) {
      data.requestHeaders.split('\n').forEach((line: string) => {
        const [key, value] = line.split(':').map((s: string) => s.trim());
        if (key && value) {
          headers[key] = value;
        }
      });
    }
    
    const validation: any = {};
    if (data.containsText?.trim()) {
      validation.containsText = data.containsText.split(',').map(s => s.trim()).filter(s => s);
    }
    
    const submitData = {
      name: data.name,
      url: fullUrl,
      type: data.type,
      checkFrequency: Math.round(data.checkFrequency / 60), // Convert seconds to minutes
      httpMethod: data.httpMethod,
      expectedStatusCodes: statusCodes,
      requestHeaders: headers,
      requestBody: data.requestBody,
      responseValidation: validation
    };
    
    console.log('Submitting check data:', submitData);
    onSubmit(submitData);
    
    // Always close the form after submission
    console.log('CheckForm onFormSubmit - closing form');
    form.reset();
    setCurrentStep(1);
    onClose();
  };

  const handleClose = () => {
    console.log('CheckForm handleClose called');
    form.reset();
    setCurrentStep(1);
    onClose();
  };

  const nextStep = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
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
      <div className={`
        fixed top-0 right-0 h-full w-full max-w-md bg-background border-l shadow-2xl z-50
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : 'translate-x-full'}
      `}>
        <ScrollArea className="h-full">
          <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                  <Plus className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">New Check</h2>
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
              <form onSubmit={form.handleSubmit(onFormSubmit)} className="space-y-6">
                {/* Step 1: Check Type */}
                {currentStep === 1 && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">What are you monitoring?</h3>
                      <p className="text-xs text-muted-foreground">
                        Choose the type of service you want to monitor
                      </p>
                    </div>
                    
                    <FormField
                      control={form.control}
                      name="type"
                      render={({ field }) => (
                        <FormItem className="space-y-3">
                          <FormControl>
                            <RadioGroup
                              onValueChange={(value) => {
                                field.onChange(value);
                                handleTypeChange(value as 'website' | 'rest_endpoint');
                              }}
                              value={field.value}
                              className="space-y-3"
                            >
                              <div className="relative">
                                <RadioGroupItem
                                  value="website"
                                  id="website"
                                  className="peer sr-only"
                                />
                                <label
                                  htmlFor="website"
                                  className={`flex items-center gap-4 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:bg-primary/10 group ${
                                    field.value === 'website'
                                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                      : 'border-border hover:border-primary'
                                  }`}
                                >
                                  <div className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                                    field.value === 'website'
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-primary/10 text-primary'
                                  }`}>
                                    <Globe className="w-5 h-5" />
                                  </div>
                                  <div className="flex-1">
                                    <div className="font-medium text-sm">Website</div>
                                    <div className="text-xs text-muted-foreground">Monitor website availability and performance</div>
                                  </div>
                                  <Check className={`w-5 h-5 transition-all ${
                                    field.value === 'website'
                                      ? 'text-primary opacity-100 scale-100'
                                      : 'text-muted-foreground opacity-0 scale-90'
                                  }`} />
                                </label>
                              </div>
                              
                              <div className="relative">
                                <RadioGroupItem
                                  value="rest_endpoint"
                                  id="rest_endpoint"
                                  className="peer sr-only"
                                />
                                <label
                                  htmlFor="rest_endpoint"
                                  className={`flex items-center gap-4 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:bg-primary/10 dark:hover:bg-primary/10 group ${
                                    field.value === 'rest_endpoint'
                                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                      : 'border-border hover:border-primary dark:hover:border-primary'
                                  }`}
                                >
                                  <div className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                                    field.value === 'rest_endpoint'
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-primary/10 text-primary'
                                  }`}>
                                    <Code className="w-5 h-5" />
                                  </div>
                                  <div className="flex-1">
                                    <div className="font-medium text-sm">API Endpoint</div>
                                    <div className="text-xs text-muted-foreground">Monitor REST APIs and microservices</div>
                                  </div>
                                  <Check className={`w-5 h-5 transition-all ${
                                    field.value === 'rest_endpoint'
                                      ? 'text-primary opacity-100 scale-100'
                                      : 'text-muted-foreground opacity-0 scale-90'
                                  }`} />
                                </label>
                              </div>
                            </RadioGroup>
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                {/* Step 2: Basic Information */}
                {currentStep === 2 && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Basic Information</h3>
                      <p className="text-xs text-muted-foreground">
                        Tell us about the service you want to monitor
                      </p>
                    </div>
                    
                    <div className="space-y-4">
                      <FormField
                        control={form.control}
                        name="url"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium">URL to monitor</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
                                  <span className="text-muted-foreground text-xs font-mono">https://</span>
                                </div>
                                <Input
                                  {...field}
                                  onChange={handleUrlChange}
                                  placeholder="example.com"
                                  className="pl-16 h-9"
                                />
                              </div>
                            </FormControl>
                            <FormDescription className="text-xs">
                              Enter the domain or full URL to monitor
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium">Display name</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="My Website"
                                className="h-9"
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              A friendly name to identify this check
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="checkFrequency"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium">Check frequency</FormLabel>
                            <FormControl>
                              <CheckIntervalSelector
                                value={field.value}
                                onChange={field.onChange}
                                helperText="How often should we check this endpoint?"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                {/* Step 3: Advanced Options */}
                {currentStep === 3 && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Advanced Configuration</h3>
                      <p className="text-xs text-muted-foreground">
                        Configure advanced monitoring options
                      </p>
                    </div>
                    
                    <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
                          <div className="grid grid-cols-2 gap-3">
                            <FormField
                              control={form.control}
                              name="httpMethod"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium">HTTP Method</FormLabel>
                                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                                    <FormControl>
                                      <SelectTrigger className="h-8 text-xs">
                                        <SelectValue placeholder="Method" />
                                      </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                      <SelectItem value="HEAD">HEAD</SelectItem>
                                      <SelectItem value="GET">GET</SelectItem>
                                      <SelectItem value="POST">POST</SelectItem>
                                      <SelectItem value="PUT">PUT</SelectItem>
                                      <SelectItem value="PATCH">PATCH</SelectItem>
                                      <SelectItem value="DELETE">DELETE</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />

                            <FormField
                              control={form.control}
                              name="expectedStatusCodes"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium">Status Codes</FormLabel>
                                  <FormControl>
                                    <Input
                                      {...field}
                                      placeholder="200,201,202"
                                      className="h-8 text-xs"
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>

                          <FormField
                            control={form.control}
                            name="requestHeaders"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium">Request Headers</FormLabel>
                                <FormControl>
                                  <Textarea
                                    {...field}
                                    placeholder="Authorization: Bearer token&#10;Content-Type: application/json"
                                    rows={2}
                                    className="text-xs"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                                                     {['POST', 'PUT', 'PATCH'].includes(watchHttpMethod || '') && (
                             <FormField
                               control={form.control}
                               name="requestBody"
                               render={({ field }) => (
                                 <FormItem>
                                   <FormLabel className="text-xs font-medium">Request Body</FormLabel>
                                   <FormControl>
                                     <Textarea
                                       {...field}
                                       placeholder='{"key": "value"}'
                                       rows={3}
                                       className="text-xs font-mono"
                                     />
                                   </FormControl>
                                   <FormMessage />
                                 </FormItem>
                               )}
                             />
                           )}

                           <FormField
                             control={form.control}
                             name="containsText"
                             render={({ field }) => (
                               <FormItem>
                                 <FormLabel className="text-xs font-medium">Response Validation</FormLabel>
                                 <FormControl>
                                   <Input
                                     {...field}
                                     placeholder="success,online,healthy"
                                     className="h-8 text-xs"
                                   />
                                 </FormControl>
                                 <FormMessage />
                               </FormItem>
                             )}
                           />
                        </div>
                  </div>
                )}

                {/* Navigation */}
                <div className="flex items-center justify-between pt-6 border-t">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={prevStep}
                    disabled={currentStep === 1}
                    className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    Back
                  </Button>
                  
                  {currentStep < 3 ? (
                    <Button
                      type="button"
                      onClick={nextStep}
                      className="h-8 px-4"
                    >
                      Next
                      <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  ) : (
                    <Button 
                      type="submit" 
                      disabled={loading}
                      className="h-8 px-4"
                    >
                      {loading ? (
                        <>
                          <Zap className="w-3 h-3 mr-1 animate-pulse" />
                          Adding...
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3 mr-1" />
                          Add Check
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </form>
            </Form>
          </div>
        </ScrollArea>
      </div>
    </>
  );
} 