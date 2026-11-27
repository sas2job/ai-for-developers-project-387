class AdminController < ApplicationController
  def index
    @event_type = EventType.new
    @event_types = EventType.order(:id)
    load_upcoming_bookings(params[:event_type_id])
  end

  def create_event_type
    @event_type = EventType.new(admin_event_type_params)

    if @event_type.save
      redirect_to admin_path, notice: "Тип встречи создан."
    else
      @event_types = EventType.order(:id)
      load_upcoming_bookings
      render :index, status: :unprocessable_entity
    end
  end

  private

  def load_upcoming_bookings(event_type_id = nil)
    @selected_event_type = @event_types.find { |event_type| event_type.id.to_s == event_type_id }
    @upcoming_bookings = Booking.upcoming
    @upcoming_bookings = @upcoming_bookings.where(event_type: @selected_event_type) if @selected_event_type
  end

  def admin_event_type_params
    params.require(:event_type).permit(:name, :description, :duration_minutes)
  end
end
