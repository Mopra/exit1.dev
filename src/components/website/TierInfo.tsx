import React, { useState, useRef, useEffect } from 'react';
import { Button, Modal } from '../ui';
import { useUserTier } from '../../hooks/useUserTier';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

const TierInfo: React.FC = () => {
  const { tierInfo, isPremium } = useUserTier();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDropdown]);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Tier Button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setShowDropdown(!showDropdown)}
        className="text-sm font-mono text-white/80 hover:text-white hover:bg-white/10 px-3 py-2 rounded border border-white/30 transition-all duration-200"
        aria-expanded={showDropdown}
        aria-label="Toggle tier information"
      >
        {isPremium ? 'Premium' : 'Free'} Tier
        <FontAwesomeIcon 
          icon={['fas', showDropdown ? 'chevron-up' : 'chevron-down']} 
          className="ml-2 w-3 h-3" 
        />
      </Button>

      {/* Dropdown Overlay */}
      {showDropdown && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-black/95 border border-white/50 rounded-lg shadow-lg z-50">
          <div className="p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/20 pb-2">
                              <h3 className="text-white font-mono font-medium text-sm uppercase tracking-wider">
                {isPremium ? 'Premium' : 'Free'} Plan
              </h3>
                              <div className="text-xs px-2 py-1 rounded-full bg-white/20 text-white font-mono border border-white/50">
                {isPremium ? 'Premium' : 'Free'}
              </div>
            </div>

            {/* Features */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm font-mono">
                <span className="text-white/80">Check frequency:</span>
                                  <span className="text-white">Every {tierInfo.checkFrequency} minute{tierInfo.checkFrequency > 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-mono">
                                  <span className="text-white/80">Website limit:</span>
                                  <span className="text-white">Up to {tierInfo.maxWebsites} websites</span>
              </div>
              <div className="flex items-center justify-between text-sm font-mono">
                                  <span className="text-white/80">Support:</span>
                                  <span className="text-white">{isPremium ? 'Priority' : 'Basic'}</span>
              </div>
            </div>

            {/* Upgrade Section for Free Users */}
            {!isPremium && (
              <div className="pt-3 border-t border-white/20">
                <div className="text-white/60 text-xs font-mono mb-3">
                  → Upgrade to premium for faster monitoring and more features
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-white hover:bg-white/20 border border-white/50 font-mono text-xs"
                  onClick={() => {
                    setShowUpgradeModal(true);
                    setShowDropdown(false);
                  }}
                >
                  Upgrade to Premium
                </Button>
              </div>
            )}

            {/* Current Features List */}
            <div className="pt-3 border-t border-white/20">
              <div className="text-white/60 text-xs font-mono mb-2">Current features:</div>
              <ul className="space-y-1">
                {tierInfo.features.map((feature, index) => (
                  <li key={index} className="text-white/80 text-xs font-mono flex items-center">
                    <FontAwesomeIcon icon={['fas', 'check']} className="w-2 h-2 mr-2 text-white" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Upgrade Modal */}
      <Modal
        isOpen={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
        title="Premium Coming Soon"
      >
        <div className="text-center space-y-4">
          <div className="text-white/80 font-mono text-sm">
            <p className="mb-3">
              We're sorry, but premium plans are not available just yet.
            </p>
            <p>
              Our premium features are currently in development and will be launching soon!
            </p>
          </div>
          
          <div className="text-white/60 text-xs font-mono">
            → Come back later priority queue, 100+ websites, integrations, and more!
          </div>
          
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-4 text-white hover:bg-white/20 border border-white/50 font-mono"
            onClick={() => setShowUpgradeModal(false)}
          >
            Got it
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default TierInfo; 