#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "Build Regnradar PWA - rain radar with animated Rain Viewer overlay, intensity graph, 20-min push warning, Swedish UI"

frontend:
  - task: "Radar animation - missing variable declarations broke Vercel iPhone build"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: false
        agent: "user"
        comment: "Radar animation completely broken on Vercel/iPhone Safari deploy. Cycles only 2 frames or freezes."
      - working: true
        agent: "main"
        comment: "ROOT CAUSE FOUND: Previous agent left `// @ts-nocheck` at top while leaving critical state/refs undeclared: radarFrameIdx, setRadarFrameIdx, currentRadarIdxRef, currentFramesRef, framesLengthRef, slotsLengthRef, setMarkerToSlotIdx. Component was crashing on iPhone Safari (no Metro HMR safety net). RESTORED all declarations + replaced create-and-destroy tile pattern with lazy-create + opacity-swap (prevents RainViewer rate-limit 429s). TypeScript strict check now passes with 0 errors. Verified locally: animation cycles 0->12 smoothly via screenshot_tool, distinct radar frames render."

  - task: "Remove debug overlay + sync graph marker with radar animation"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: false
        agent: "user"
        comment: "Two issues: (1) black debug overlay still visible in top-left corner; (2) graph marker stuck at 'now' position (~11:15/15:00) instead of following the currently displayed radar frame's time."
      - working: true
        agent: "main"
        comment: "Removed the debug-counter <div> overlay entirely + removed the per-tick console.log. Made graph marker time-driven: (a) added `activeFrameTime` prop to RainGraph; (b) `initialMarkerX` now interpolates linearly between slots[0].time and slots[n-1].time based on the active radar frame's time; (c) currentIdx is now derived (useMemo) from the slot nearest to the radar frame's time, so the active-bar highlight + top mm/h readout also sync with the radar; (d) step() handler updates radarFrameIdx instead of dead currentIdx state. Verified visually: 4 distinct marker x positions over 14 ticks (interpolated between slots, not snapping)."

agent_communication:
  - agent: "main"
    message: "Both user-requested fixes implemented. Debug overlay gone. Graph marker now interpolates smoothly between slot positions based on the actual time of the currently-displayed radar frame. Note: marker will only traverse the LEFT half of the chart (≈now-1h to now+30min) because RainViewer's radar coverage is limited to that range, while the chart extends to now+2h (Open-Meteo forecast)."

