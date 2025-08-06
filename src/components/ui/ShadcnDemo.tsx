import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faChevronDown, faUser, faCog, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from './index';

export function ShadcnDemo() {
  const [switchValue, setSwitchValue] = useState(false);
  const [showAlertDialog, setShowAlertDialog] = useState(false);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold mb-2">shadcn/ui Components Demo</h1>
        <p className="text-muted-foreground">Showcasing the new shadcn/ui components</p>
      </div>

      {/* Alerts */}
      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>Different types of alert messages</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <FontAwesomeIcon icon={faCheck} className="w-4 h-4" />
            <AlertTitle>Success!</AlertTitle>
            <AlertDescription>
              This is a default alert message with a title and description.
            </AlertDescription>
          </Alert>
          
          <Alert variant="destructive">
            <FontAwesomeIcon icon={faCheck} className="w-4 h-4" />
            <AlertDescription>
              This is a destructive alert for error messages.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Card>
        <CardHeader>
          <CardTitle>Tabs</CardTitle>
          <CardDescription>Organize content into tabs</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="account" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="account" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="Enter your name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="Enter your email" />
              </div>
            </TabsContent>
            <TabsContent value="password" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current">Current password</Label>
                <Input id="current" type="password" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new">New password</Label>
                <Input id="new" type="password" />
              </div>
            </TabsContent>
            <TabsContent value="settings" className="space-y-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="notifications"
                  checked={switchValue}
                  onCheckedChange={setSwitchValue}
                />
                <Label htmlFor="notifications">Enable notifications</Label>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Dropdown Menu */}
      <Card>
        <CardHeader>
          <CardTitle>Dropdown Menu</CardTitle>
          <CardDescription>Context menus and dropdowns</CardDescription>
        </CardHeader>
        <CardContent>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                Open Menu
                <FontAwesomeIcon icon={faChevronDown} className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>My Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <FontAwesomeIcon icon={faUser} className="mr-2 h-4 w-4" />
                <span>Profile</span>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <FontAwesomeIcon icon={faCog} className="mr-2 h-4 w-4" />
                <span>Settings</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <FontAwesomeIcon icon={faSignOutAlt} className="mr-2 h-4 w-4" />
                <span>Log out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      {/* Form Elements */}
      <Card>
        <CardHeader>
          <CardTitle>Form Elements</CardTitle>
          <CardDescription>Input fields and form controls</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="select-demo">Select</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select an option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="option1">Option 1</SelectItem>
                  <SelectItem value="option2">Option 2</SelectItem>
                  <SelectItem value="option3">Option 3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="switch-demo">Switch</Label>
              <div className="flex items-center space-x-2">
                <Switch id="switch-demo" />
                <Label htmlFor="switch-demo">Toggle me</Label>
              </div>
            </div>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="textarea-demo">Textarea</Label>
            <Textarea
              id="textarea-demo"
              placeholder="Enter your message here..."
              className="min-h-[100px]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Alert Dialog */}
      <Card>
        <CardHeader>
          <CardTitle>Alert Dialog</CardTitle>
          <CardDescription>Confirmation dialogs</CardDescription>
        </CardHeader>
        <CardContent>
          <AlertDialog open={showAlertDialog} onOpenChange={setShowAlertDialog}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete Account</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete your account
                  and remove your data from our servers.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction>Continue</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      <Separator />

      <div className="text-center text-sm text-muted-foreground">
        <p>These components are built with shadcn/ui and styled with Tailwind CSS</p>
      </div>
    </div>
  );
} 