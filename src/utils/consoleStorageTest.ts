// Utility functions to test console storage functionality

export const testConsoleStorage = () => {
  const testState = {
    position: { x: 100, y: 200 },
    size: { width: 500, height: 300 },
    isMinimized: false,
    isMaximized: true,
  };

  // Test saving
  try {
    localStorage.setItem('console-state', JSON.stringify(testState));
    console.log('✅ Console state saved successfully');
  } catch (error) {
    console.error('❌ Failed to save console state:', error);
    return false;
  }

  // Test loading
  try {
    const loaded = localStorage.getItem('console-state');
    const parsed = JSON.parse(loaded || '{}');
    console.log('✅ Console state loaded successfully:', parsed);
    
    // Verify the loaded state matches what we saved
    const isCorrect = JSON.stringify(parsed) === JSON.stringify(testState);
    console.log(isCorrect ? '✅ Loaded state matches saved state' : '❌ Loaded state does not match saved state');
    
    return isCorrect;
  } catch (error) {
    console.error('❌ Failed to load console state:', error);
    return false;
  }
};

export const clearConsoleStorage = () => {
  try {
    localStorage.removeItem('console-state');
    console.log('✅ Console state cleared successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to clear console state:', error);
    return false;
  }
};

export const getConsoleStorageInfo = () => {
  try {
    const stored = localStorage.getItem('console-state');
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        exists: true,
        data: parsed,
        size: stored.length,
      };
    } else {
      return {
        exists: false,
        data: null,
        size: 0,
      };
    }
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}; 