import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';

interface CheckUsageProps {
  className?: string;
}

const CheckUsage: React.FC<CheckUsageProps> = ({ className = '' }) => {
  // Mock data - replace with real usage data
  const usage = {
    current: 5,
    limit: 10,
    percentage: 50
  };

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Check Usage
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Used</span>
          <span className="font-medium">
            {usage.current} / {usage.limit}
          </span>
        </div>
        <Progress value={usage.percentage} className="h-2" />
        <div className="flex items-center justify-between">
          <Badge variant="outline" className="text-xs">
            Free Plan
          </Badge>
          <span className="text-xs text-muted-foreground">
            {usage.limit - usage.current} remaining
          </span>
        </div>
      </CardContent>
    </Card>
  );
};

export default CheckUsage; 